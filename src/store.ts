import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { Message, ToolResultBlock, ToolSpec } from "./types.ts";

// 對話紀錄存在 SQLite

export type SessionInfo = {
  id: string;
  chatId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 最後一次呼叫模型送出的 token 數；null 表示還不知道（還沒呼叫過，或 API 沒回報） */
  lastInputTokens: number | null;
};

export type Store = ReturnType<typeof openStore>;

const SCHEMA = `
-- system prompt 和工具清單（JSON）依內容去重，一份只存一次；從哪個欄位指過來就是哪一種。
-- 內容不會改（hash 就是內容）：created_at 是第一次存的時間，updated_at 是最後一次有 session 換成這份的時間
CREATE TABLE IF NOT EXISTS prompts (
  hash TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_input_tokens INTEGER,
  system_prompt_hash TEXT REFERENCES prompts (hash),
  tools_hash TEXT REFERENCES prompts (hash)
);
CREATE INDEX IF NOT EXISTS sessions_by_chat ON sessions (chat_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, id);
`;

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);

  const insertSession = db.prepare(
    "INSERT INTO sessions (id, chat_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)");
  const touchSession = db.prepare(
    `UPDATE sessions SET message_count = message_count + 1, updated_at = ?,
       model = COALESCE(?, model), last_input_tokens = COALESCE(?, last_input_tokens)
     WHERE id = ?`,
  );
  const selectSession = db.prepare("SELECT * FROM sessions WHERE id = ? AND chat_id = ?");
  const selectRecent = db.prepare("SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?");
  const selectMessages = db.prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id");
  const updateTitle = db.prepare("UPDATE sessions SET title = ? WHERE id = ?");
  const selectChatIds = db.prepare("SELECT DISTINCT chat_id FROM sessions");
  const upsertPrompt = db.prepare(
    `INSERT INTO prompts (hash, prompt, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (hash) DO UPDATE SET updated_at = excluded.updated_at`,
  );
  const updateSessionPrompt = db.prepare("UPDATE sessions SET system_prompt_hash = ? WHERE id = ?");
  const selectSessionPrompt = db.prepare(
    "SELECT p.prompt FROM sessions s JOIN prompts p ON p.hash = s.system_prompt_hash WHERE s.id = ?",
  );
  const updateSessionTools = db.prepare("UPDATE sessions SET tools_hash = ? WHERE id = ?");
  const selectSessionTools = db.prepare(
    "SELECT p.prompt FROM sessions s JOIN prompts p ON p.hash = s.tools_hash WHERE s.id = ?",
  );

  /** 存一份內容（已經有就只更新 updated_at），再把 session 的欄位指向它 */
  function pin(pointer: StatementSync, sessionId: string, content: string): void {
    const hash = promptHash(content);
    const now = new Date().toISOString();
    transaction(() => {
      upsertPrompt.run(hash, content, now, now);
      pointer.run(hash, sessionId);
    });
  }

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    createSession(chatId: string, title: string, model: string): SessionInfo {
      // 同一秒開兩段才可能撞名，撞了就換一組亂碼
      for (let attempt = 1; ; attempt++) {
        const now = new Date();
        const id = `${idTimestamp(now)}-${randomBytes(2).toString("hex")}`;
        try {
          insertSession.run(id, chatId, title, model, now.toISOString(), now.toISOString());
          return { id, chatId, title, model, createdAt: now.toISOString(), updatedAt: now.toISOString(), messageCount: 0, lastInputTokens: null };
        } catch (error) {
          if (attempt >= 5 || !isUniqueViolation(error)) throw error;
        }
      }
    },

    /** 存一則訊息，同時更新 session 資訊，兩件事在同一筆交易裡完成 */
    appendMessage(sessionId: string, message: Message, usage?: { model: string; inputTokens: number | null }): void {
      const now = new Date().toISOString();
      transaction(() => {
        insertMessage.run(sessionId, message.role, JSON.stringify(message.content), now);
        touchSession.run(now, usage?.model ?? null, usage?.inputTokens ?? null, sessionId);
      });
    },

    /** 只找得到這個聊天室自己的 session */
    getSession(chatId: string, id: string): SessionInfo | undefined {
      const row = selectSession.get(id, chatId);
      return row ? toSessionInfo(row) : undefined;
    },

    /** 最近的 session，最後活動時間新的在前 */
    listSessions(chatId: string, limit: number): SessionInfo[] {
      return selectRecent.all(chatId, limit).map(toSessionInfo);
    },

    /** 有過對話的聊天室 */
    listChatIds(): string[] {
      return selectChatIds.all().map((row) => String(row["chat_id"]));
    },

    renameSession(id: string, title: string): void {
      updateTitle.run(title, id);
    },

    /** 這段 session 凍結的 system prompt；還沒凍結（新的，或升級前就存在的）時是 undefined */
    getSystemPrompt(sessionId: string): string | undefined {
      const row = selectSessionPrompt.get(sessionId);
      return row ? String(row["prompt"]) : undefined;
    },

    /** 凍結（或換成）這份 system prompt。內容一樣的只存一份，舊版不刪 */
    setSystemPrompt(sessionId: string, prompt: string): void {
      pin(updateSessionPrompt, sessionId, prompt);
    },

    /** 這段 session 凍結的工具清單；還沒凍結時是 undefined */
    getTools(sessionId: string): ToolSpec[] | undefined {
      const row = selectSessionTools.get(sessionId);
      return row ? (JSON.parse(String(row["prompt"])) as ToolSpec[]) : undefined;
    },

    /** 凍結（或換成）這份工具清單，存的是送給模型的工具定義 JSON */
    setTools(sessionId: string, tools: ToolSpec[]): void {
      pin(updateSessionTools, sessionId, JSON.stringify(tools));
    },

    loadMessages(sessionId: string): Message[] {
      const messages = selectMessages.all(sessionId).map(
        (row) => ({ role: String(row["role"]), content: JSON.parse(String(row["content"])) }) as Message,
      );
      return repair(messages);
    },
  };
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/** 舊的資料庫補上後來加的欄位。CREATE TABLE IF NOT EXISTS 不會改已經存在的表 */
function migrate(db: DatabaseSync): void {
  const columnsOf = (table: string) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row["name"])));

  const sessions = columnsOf("sessions");
  for (const column of ["system_prompt_hash", "tools_hash"]) {
    if (!sessions.has(column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT REFERENCES prompts (hash)`);
  }

  // ALTER TABLE 加的欄位不能用 NOT NULL 又沒有固定的預設值，所以先加可為空的欄位再補值。
  // 舊資料不知道實際的時間，用指向它的 session 裡最早建立的時間代替，都沒有就用現在
  const prompts = columnsOf("prompts");
  const now = new Date().toISOString();
  for (const column of ["created_at", "updated_at"]) {
    if (prompts.has(column)) continue;
    db.exec(`ALTER TABLE prompts ADD COLUMN ${column} TEXT`);
    db.prepare(
      `UPDATE prompts SET ${column} = COALESCE(
         (SELECT MIN(s.created_at) FROM sessions s WHERE prompts.hash IN (s.system_prompt_hash, s.tools_hash)), ?)
       WHERE ${column} IS NULL`,
    ).run(now);
  }
}

/**
 * 讓讀回來的對話符合 API 的規則：
 * - 連續的用戶訊息合併成一則（例如停在步數上限後又傳了訊息，記憶體裡是合併的，存的時候是分開的）
 * - 工具呼叫一定要有對應的結果（執行到一半當機就會缺），缺的補上「中斷」
 */
function repair(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const last = result.at(-1);
    if (message.role === "user" && last?.role === "user") last.content.push(...message.content);
    else result.push(message);
  }

  for (let index = 0; index < result.length; index++) {
    const message = result[index];
    if (message?.role !== "assistant") continue;
    const callIds = message.content.flatMap((block) => (block.type === "tool_call" ? [block.id] : []));
    if (callIds.length === 0) continue;

    let next = result[index + 1];
    if (next?.role !== "user") {
      next = { role: "user", content: [] };
      result.splice(index + 1, 0, next);
    }
    const answered = new Set(next.content.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])));
    const missing: ToolResultBlock[] = callIds
      .filter((id) => !answered.has(id))
      .map((id) => ({ type: "tool_result", toolCallId: id, content: "（執行中斷，沒有結果）", isError: true }));
    next.content.unshift(...missing);
  }
  return result;
}

function toSessionInfo(row: Record<string, SQLOutputValue>): SessionInfo {
  const tokens = row["last_input_tokens"];
  return {
    id: String(row["id"]),
    chatId: String(row["chat_id"]),
    title: String(row["title"]),
    model: String(row["model"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    messageCount: Number(row["message_count"]),
    lastInputTokens: tokens === null || tokens === undefined ? null : Number(tokens),
  };
}

/** 20261119-150312，用本機時間，看 ID 就知道什麼時候開的 */
function idTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
