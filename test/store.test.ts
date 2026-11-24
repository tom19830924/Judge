import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { openStore, promptHash, type Store } from "../src/store.ts";
import type { Message } from "../src/types.ts";

function freshStore(): Store {
  return openStore(join(mkdtempSync(join(tmpdir(), "bj-db-")), "test.db"));
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

test("createSession：回傳初始資訊，ID 不重複", () => {
  const store = freshStore();
  const a = store.createSession("chat1", "標題", "claude-opus-5-5");
  const b = store.createSession("chat1", "標題", "claude-opus-5-5");
  assert.equal(a.title, "標題");
  assert.equal(a.messageCount, 0);
  assert.equal(a.lastInputTokens, null);
  assert.notEqual(a.id, b.id);
});

test("getSession：只找得到自己聊天室的 session", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  assert.ok(store.getSession("chat1", session.id));
  assert.equal(store.getSession("chat2", session.id), undefined);
});

test("appendMessage + loadMessages：存進去再讀回來一致", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  store.appendMessage(session.id, userText("你好"));
  store.appendMessage(session.id, assistantText("哈囉"));

  const loaded = store.loadMessages(session.id);
  assert.deepEqual(loaded, [userText("你好"), assistantText("哈囉")]);
});

test("appendMessage：帶 usage 時更新 message_count 和 last_input_tokens", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  store.appendMessage(session.id, userText("hi"));
  store.appendMessage(session.id, assistantText("yo"), { model: "m", inputTokens: 1234 });

  const info = store.getSession("chat1", session.id);
  assert.equal(info?.messageCount, 2);
  assert.equal(info?.lastInputTokens, 1234);
});

test("listChatIds：列出有過對話的聊天室，不重複", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-store-")), "test.db"));
  store.createSession("chat1", "a", "m");
  store.createSession("chat1", "b", "m");
  store.createSession("chat2", "c", "m");
  assert.deepEqual(store.listChatIds().sort(), ["chat1", "chat2"]);
});

test("listSessions：最後活動時間新的在前", async () => {
  const store = freshStore();
  const first = store.createSession("chat1", "舊", "m");
  const second = store.createSession("chat1", "新", "m");
  // 留時間差，確保 first 的 updated_at 確實晚於 second（否則同毫秒時排序不確定）
  await delay(5);
  store.appendMessage(first.id, userText("碰一下"));

  const list = store.listSessions("chat1", 10);
  assert.equal(list[0]?.id, first.id);
  assert.equal(list[1]?.id, second.id);
});

test("renameSession：改標題", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "舊名", "m");
  store.renameSession(session.id, "新名");
  assert.equal(store.getSession("chat1", session.id)?.title, "新名");
});

test("repair：讀回時合併連續的用戶訊息", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  store.appendMessage(session.id, userText("第一句"));
  store.appendMessage(session.id, userText("第二句"));

  const loaded = store.loadMessages(session.id);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], {
    role: "user",
    content: [
      { type: "text", text: "第一句" },
      { type: "text", text: "第二句" },
    ],
  });
});

test("repair：工具呼叫沒有結果時補上「中斷」", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  // 模型呼叫了工具，但執行到一半當機，沒有存下 tool_result
  store.appendMessage(session.id, {
    role: "assistant",
    content: [{ type: "tool_call", id: "call_1", name: "run_command", input: { command: "ls" } }],
  });

  const loaded = store.loadMessages(session.id);
  assert.equal(loaded.length, 2, "補出一則 user 訊息放工具結果");
  const result = loaded[1];
  assert.equal(result?.role, "user");
  assert.deepEqual(result?.content, [
    { type: "tool_result", toolCallId: "call_1", content: "（執行中斷，沒有結果）", isError: true },
  ]);
});

test("repair：工具呼叫已有結果時不重複補", () => {
  const store = freshStore();
  const session = store.createSession("chat1", "標題", "m");
  store.appendMessage(session.id, {
    role: "assistant",
    content: [{ type: "tool_call", id: "call_1", name: "read_file", input: { path: "a" } }],
  });
  store.appendMessage(session.id, {
    role: "user",
    content: [{ type: "tool_result", toolCallId: "call_1", content: "檔案內容", isError: false }],
  });

  const loaded = store.loadMessages(session.id);
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded[1]?.content, [
    { type: "tool_result", toolCallId: "call_1", content: "檔案內容", isError: false },
  ]);
});

test("setSystemPrompt / getSystemPrompt：凍結、替換，內容一樣只存一份", () => {
  const store = freshStore();
  const a = store.createSession("chat1", "a", "m");
  const b = store.createSession("chat1", "b", "m");
  assert.equal(store.getSystemPrompt(a.id), undefined, "新的 session 還沒凍結");

  store.setSystemPrompt(a.id, "v1");
  store.setSystemPrompt(b.id, "v1");
  assert.equal(store.getSystemPrompt(a.id), "v1");
  assert.equal(store.getSystemPrompt(b.id), "v1");

  store.setSystemPrompt(a.id, "v2");
  assert.equal(store.getSystemPrompt(a.id), "v2");
  assert.equal(store.getSystemPrompt(b.id), "v1", "不影響別段");
});

test("promptHash：同樣內容同樣 hash", () => {
  assert.equal(promptHash("abc"), promptHash("abc"));
  assert.notEqual(promptHash("abc"), promptHash("abd"));
  assert.match(promptHash("abc"), /^[0-9a-f]{64}$/);
});

test("舊資料庫：自動補上 system_prompt_hash 欄位，原本的資料還在", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bj-db-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, last_input_tokens INTEGER)`);
  old.exec("INSERT INTO sessions VALUES ('s1', 'chat1', '舊的', 'm', '2026-01-01', '2026-01-01', 0, NULL)");
  old.close();

  const store = openStore(path);
  assert.equal(store.getSession("chat1", "s1")?.title, "舊的");
  assert.equal(store.getSystemPrompt("s1"), undefined);
  store.setSystemPrompt("s1", "v1");
  assert.equal(store.getSystemPrompt("s1"), "v1");
  openStore(path); // 再開一次不會重複加欄位
});

test("prompts：第一次存記建立時間，之後又有 session 換成同一份時只更新 updated_at", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "bj-db-")), "test.db");
  const store = openStore(path);
  const a = store.createSession("chat1", "a", "m");
  const b = store.createSession("chat1", "b", "m");
  const read = () =>
    new DatabaseSync(path).prepare("SELECT created_at, updated_at FROM prompts WHERE hash = ?").get(promptHash("v1")) as {
      created_at: string;
      updated_at: string;
    };

  store.setSystemPrompt(a.id, "v1");
  const first = read();
  assert.equal(first.created_at, first.updated_at);

  await delay(5);
  store.setSystemPrompt(b.id, "v1");
  const second = read();
  assert.equal(second.created_at, first.created_at, "建立時間不變");
  assert.ok(second.updated_at > first.updated_at, "更新時間往後");
});

test("舊資料庫：prompts 沒有時間欄位時補上，用指向它的 session 建立時間", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bj-db-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL)");
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, last_input_tokens INTEGER,
    system_prompt_hash TEXT)`); // 沒有 tools_hash，也要能補上
  old.prepare("INSERT INTO prompts VALUES (?, 'v1')").run(promptHash("v1"));
  old.prepare("INSERT INTO prompts VALUES (?, '沒人用')").run(promptHash("沒人用"));
  old.prepare("INSERT INTO sessions VALUES ('s1', 'chat1', 't', 'm', '2026-01-02', '2026-01-03', 0, NULL, ?)").run(promptHash("v1"));
  old.prepare("INSERT INTO sessions VALUES ('s2', 'chat1', 't', 'm', '2026-01-01', '2026-01-03', 0, NULL, ?)").run(promptHash("v1"));
  old.close();

  const store = openStore(path);
  assert.equal(store.getSystemPrompt("s1"), "v1");
  const rows = new DatabaseSync(path).prepare("SELECT prompt, created_at, updated_at FROM prompts ORDER BY prompt").all();
  const used = rows.find((row) => row["prompt"] === "v1");
  const unused = rows.find((row) => row["prompt"] === "沒人用");
  assert.equal(used?.["created_at"], "2026-01-01", "取最早的 session");
  assert.equal(used?.["updated_at"], "2026-01-01");
  assert.ok(unused?.["created_at"], "沒有 session 指向的用現在");
  openStore(path); // 再開一次不會重複加欄位
});

test("setTools / getTools：存的是工具定義 JSON，跟 system prompt 放同一張表", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bj-db-")), "test.db");
  const store = openStore(path);
  const session = store.createSession("chat1", "a", "m");
  assert.equal(store.getTools(session.id), undefined);

  const tools = [{ name: "read_file", description: "讀檔", inputSchema: { type: "object" } }];
  store.setTools(session.id, tools);
  store.setSystemPrompt(session.id, "v1");
  assert.deepEqual(store.getTools(session.id), tools);
  assert.equal(store.getSystemPrompt(session.id), "v1", "兩個欄位互不影響");
  const count = new DatabaseSync(path).prepare("SELECT COUNT(*) AS n FROM prompts").get();
  assert.equal(count?.["n"], 2);
});
