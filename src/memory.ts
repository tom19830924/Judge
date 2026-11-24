import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Tool, ToolContext } from "./tools.ts";

/**
 * 記憶：代理人資料夾的 MEMORY.md，一行一條（「- 」開頭）。
 * 由模型判斷要不要記，用 memory 工具新增、修改、刪除；程式只照做（直接寫，或先問用戶）。
 * 寫入只存檔，這段對話凍結的 system prompt 不變（快取不失效）；這段對話靠工具呼叫的紀錄知道改了什麼。
 */

export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;

/**
 * 記憶的分類，寫在每條開頭，例如「[偏好] 用戶偏好一題一題問」。
 * 身份、人格、規則不算記憶，放 IDENTITY.md
 */
export const MEMORY_CATEGORIES = {
  偏好: "用戶的喜好、習慣、溝通方式，例如偏好一題一題問",
  知識: "用戶、環境、專案的事實，例如用戶在哪裡工作、專案用什麼測試框架",
  經驗: "做事學到的教訓、踩過的坑、被糾正過的事",
} as const;
export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
const CATEGORY_NAMES = Object.keys(MEMORY_CATEGORIES) as MemoryCategory[];

export type MemoryOptions = {
  /** MEMORY.md 的路徑 */
  path: string;
  /** true：寫入前先問用戶 */
  approval: boolean;
  /** 整個檔案的字數上限（以字元計） */
  charLimit: number;
};

/** add、replace 的 content 已經帶上分類標籤（parseChange 加的） */
export type MemoryChange =
  | { action: "add"; content: string }
  | { action: "replace"; oldText: string; content: string }
  | { action: "remove"; oldText: string };

/** 「[偏好] 內容」：模型自己加了標籤就先拿掉，再用 category 參數的那個 */
export function withCategory(category: MemoryCategory, content: string): string {
  const body = normalizeEntry(content).replace(/^\[[^\]]*\]\s*/, "");
  return body === "" ? "" : `[${category}] ${body}`;
}

/** 每個非空行是一條，去掉開頭的「- 」。用戶手動編輯沒加「- 」的行也算一條 */
export function parseEntries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
    .filter((line) => line !== "");
}

export function formatEntries(entries: readonly string[]): string {
  return entries.map((entry) => `- ${entry}\n`).join("");
}

/** 以字元計，中文、emoji 都算一個 */
export function charCount(text: string): number {
  return [...text].length;
}

/** 一條記憶只能一行：換行換成空白，去掉模型自己加的「- 」 */
export function normalizeEntry(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim().replace(/^[-*]\s+/, "").trim();
}

/** 用部分原文找出要改的那一條。完全相同的優先；找不到或找到好幾條都報錯 */
function findEntry(entries: readonly string[], oldText: string): number {
  const needle = normalizeEntry(oldText);
  if (needle === "") throw new Error("old_text 不能是空的，要給那一條記憶的部分原文");
  const exact = entries.indexOf(needle);
  if (exact !== -1) return exact;
  const matches = entries.flatMap((entry, index) => (entry.includes(needle) ? [index] : []));
  if (matches.length === 0) throw new Error(`找不到含有「${needle}」的記憶。${listing(entries)}`);
  if (matches.length > 1) {
    throw new Error(`「${needle}」同時出現在 ${matches.length} 條記憶，請給更完整的原文：\n${matches.map((i) => `- ${entries[i]}`).join("\n")}`);
  }
  return matches[0] as number;
}

function listing(entries: readonly string[]): string {
  return entries.length === 0 ? "目前沒有任何記憶。" : `目前的記憶：\n${formatEntries(entries)}`;
}

/** 套用一個變動，回傳新的條目。不合法或超過上限就丟錯，錯誤訊息是給模型看的 */
export function applyChange(entries: readonly string[], change: MemoryChange, charLimit: number): string[] {
  const next = [...entries];
  if (change.action === "add" || change.action === "replace") {
    const content = normalizeEntry(change.content);
    if (content === "") throw new Error("content 不能是空的");
    if (change.action === "add") {
      if (next.includes(content)) throw new Error(`已經有這條記憶了：${content}`);
      next.push(content);
    } else {
      next[findEntry(next, change.oldText)] = content;
    }
  } else {
    next.splice(findEntry(next, change.oldText), 1);
  }

  const size = charCount(formatEntries(next));
  if (size > charLimit && change.action !== "remove") {
    throw new Error(
      `超過記憶上限：寫入後會是 ${size}/${charLimit} 字，至少要騰出 ${size - charLimit} 字。` +
        `請先用 replace 合併、縮短，或用 remove 刪掉過時的記憶，再寫入。\n${listing(entries)}`,
    );
  }
  return next;
}

/** 給用戶看的變動描述（核准按鈕的訊息、log） */
export function describeChange(entries: readonly string[], change: MemoryChange): string {
  switch (change.action) {
    case "add":
      return `新增：${normalizeEntry(change.content)}`;
    case "replace":
      return `修改：${entries[findEntry(entries, change.oldText)]}\n改成：${normalizeEntry(change.content)}`;
    case "remove":
      return `刪除：${entries[findEntry(entries, change.oldText)]}`;
  }
}

export function readEntries(path: string): string[] {
  return existsSync(path) ? parseEntries(readFileSync(path, "utf8")) : [];
}

/** 先寫暫存檔再改名，寫到一半中斷也不會留下壞掉的 MEMORY.md */
export function writeEntries(path: string, entries: readonly string[]): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, formatEntries(entries));
  renameSync(temp, path);
}

export function parseChange(input: Record<string, unknown>): MemoryChange {
  const text = (key: string) => {
    const value = input[key];
    if (typeof value !== "string") throw new Error(`action 是 ${String(input["action"])} 時要給 ${key}（字串）`);
    return value;
  };
  const category = () => {
    const value = input["category"];
    if (typeof value === "string" && (CATEGORY_NAMES as string[]).includes(value)) return value as MemoryCategory;
    throw new Error(
      `action 是 ${String(input["action"])} 時要給 category，只能是 ${CATEGORY_NAMES.join("、")}。` +
        "講你扮演誰、怎麼說話、要守什麼規則的不是記憶，要改 IDENTITY.md",
    );
  };
  switch (input["action"]) {
    case "add":
      return { action: "add", content: withCategory(category(), text("content")) };
    case "replace":
      return { action: "replace", oldText: text("old_text"), content: withCategory(category(), text("content")) };
    case "remove":
      return { action: "remove", oldText: text("old_text") };
    default:
      throw new Error(`不認識的 action：${String(input["action"])}，只能用 add、replace、remove`);
  }
}

const ACTION_LABEL = { add: "新增", replace: "修改", remove: "刪除" } as const;

export function createMemoryTool(options: MemoryOptions): Tool {
  return {
    spec: {
      name: "memory",
      description: [
        "寫入跨對話的長期記憶（MEMORY.md）。記憶會放進之後每段對話的 system prompt，所以要精簡、有用。",
        "",
        "什麼時候用：只記之後每段對話都用得到的事。例如用戶的偏好和習慣、用戶糾正過你的事、穩定的環境資訊、專案的長期慣例、踩過的坑。用戶說「記住…」就記；說「忘掉…」就刪。",
        "",
        `分類（category，add、replace 必填，程式會加在開頭，例如「[偏好] …」）：${CATEGORY_NAMES.map((name) => `${name}：${MEMORY_CATEGORIES[name]}`).join("；")}。`,
        "",
        "不是記憶的：講你扮演誰（身份）、怎麼說話（人格）、要守什麼規則的，就算用戶沒說「改身份」，也要改 IDENTITY.md（路徑在 system prompt 的「## 關於 IDENTITY.md」），不要用這個工具。例如「你是我在某公司的 iOS 代理人」是身份；但其中「用戶在某公司做 iOS」這個事實可以另外記成知識。拿不準就先問用戶。",
        "",
        "不要記：瑣碎或顯而易見的事、查檔案或程式碼就知道的事、這次任務的進度、做完的工作紀錄、暫時的待辦。",
        "",
        "怎麼寫：一條一件事，一行，寫成事實而不是命令。例如「用戶偏好選項一題一題問」✓，「一次只能問一題」✗。寫成命令的話，之後會被當成指令，蓋掉用戶當下的要求。記憶跟用戶當下說的衝突時，以用戶當下說的為準，必要時更新記憶。",
        "",
        `動作：add 新增一條；replace 把某一條換成新內容（old_text 給那一條的部分原文）；remove 刪除某一條（old_text 同上）。一次呼叫做一個動作。`,
        "",
        `上限：整份記憶 ${options.charLimit} 字。超過時 add 會被拒絕並列出現有記憶，請先用 replace 合併、縮短，或 remove 過時的，再寫入。`,
        "",
        "程式不會另外通知用戶，寫完要在回覆中告訴用戶記了什麼。" +
          (options.approval ? "寫入前會先請用戶核准，用戶拒絕就不要再試同一筆。" : ""),
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"], description: "add、replace 或 remove" },
          category: { type: "string", enum: CATEGORY_NAMES, description: "add、replace 時必填：這條記憶的分類" },
          content: { type: "string", description: "add、replace 時必填：新的那一條記憶，一行，不用自己加分類標籤" },
          old_text: { type: "string", description: "replace、remove 時必填：要改的那一條記憶的部分原文，要能唯一對到一條" },
        },
        required: ["action"],
      },
    },
    run: (input, signal, context) => runMemory(options, parseChange(input), signal, context),
  };
}

async function runMemory(options: MemoryOptions, change: MemoryChange, signal?: AbortSignal, context?: ToolContext): Promise<string> {
  const who = context ? `[${context.chatId}] ` : "";
  // 先檢查一次（找不到、超過上限就不用問用戶了）
  const before = readEntries(options.path);
  applyChange(before, change, options.charLimit);
  const description = describeChange(before, change);

  if (options.approval) {
    if (!context) throw new Error("沒有辦法詢問用戶，未寫入");
    const answer = await context.requestApproval(`🧠 想${description}`, signal);
    if (answer !== "approved") {
      const reason = answer === "denied" ? "用戶拒絕了，未寫入。不要再試同一筆。" : `沒有等到核准（${answer.cancelled}），未寫入。`;
      console.log(`${who}記憶${ACTION_LABEL[change.action]}未寫入：${answer === "denied" ? "拒絕" : answer.cancelled}`);
      return reason;
    }
  }

  // 等核准的期間檔案可能被改過，重新讀一次再套用
  const entries = applyChange(readEntries(options.path), change, options.charLimit);
  writeEntries(options.path, entries);
  const size = charCount(formatEntries(entries));
  console.log(`${who}記憶${description.replace("\n", " ")}（${size}/${options.charLimit} 字）`);
  return (
    `已寫入。${description}\n記憶目前 ${size}/${options.charLimit} 字。` + "程式不會另外通知用戶，請在回覆中告訴用戶記了什麼。"
  );
}
