import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyChange,
  charCount,
  createMemoryTool,
  describeChange,
  formatEntries,
  normalizeEntry,
  parseChange,
  parseEntries,
  readEntries,
  withCategory,
  writeEntries,
} from "../src/memory.ts";
import type { ApprovalAnswer, ToolContext } from "../src/tools.ts";

const tempMemory = (content?: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "judge-memory-")), "MEMORY.md");
  if (content !== undefined) writeFileSync(path, content);
  return path;
};

/** 假的核准：照腳本回答，記下問了什麼 */
function fakeContext(answer: ApprovalAnswer | ((signal?: AbortSignal) => Promise<ApprovalAnswer>)) {
  const asked: string[] = [];
  const context: ToolContext = {
    chatId: "c1",
    requestApproval: async (text, signal) => {
      asked.push(text);
      return typeof answer === "function" ? answer(signal) : answer;
    },
    askUser: async () => ({ cancelled: "測試不支援" }),
  };
  return { context, asked };
}

// ── 格式 ──

test("parseEntries：每個非空行一條，去掉「- 」；沒加「- 」的行也算", () => {
  assert.deepEqual(parseEntries("- 甲\n\n-  乙 \n丙\n* 丁\n"), ["甲", "乙", "丙", "丁"]);
  assert.deepEqual(parseEntries(""), []);
});

test("formatEntries：一行一條，「- 」開頭，最後有換行", () => {
  assert.equal(formatEntries(["甲", "乙"]), "- 甲\n- 乙\n");
  assert.equal(formatEntries([]), "");
});

test("normalizeEntry：換行變空白，去掉模型自己加的「- 」", () => {
  assert.equal(normalizeEntry("- 第一行\n  第二行 "), "第一行 第二行");
});

test("charCount：以字元計，中文和 emoji 都算一個", () => {
  assert.equal(charCount("中文ab🧠"), 5);
});

// ── 變動 ──

test("applyChange add：接在最後；重複的拒絕；空的拒絕", () => {
  assert.deepEqual(applyChange(["甲"], { action: "add", content: "乙" }, 100), ["甲", "乙"]);
  assert.throws(() => applyChange(["甲"], { action: "add", content: "- 甲" }, 100), /已經有這條記憶了/);
  assert.throws(() => applyChange([], { action: "add", content: " \n " }, 100), /content 不能是空的/);
});

test("applyChange replace：用部分原文找到那一條換掉", () => {
  assert.deepEqual(
    applyChange(["用戶偏好簡潔", "專案用 node:test"], { action: "replace", oldText: "node:test", content: "專案測試用 node:test，不裝套件" }, 100),
    ["用戶偏好簡潔", "專案測試用 node:test，不裝套件"],
  );
});

test("applyChange remove：刪掉那一條", () => {
  assert.deepEqual(applyChange(["甲一", "乙二"], { action: "remove", oldText: "乙" }, 100), ["甲一"]);
});

test("applyChange：找不到、對到好幾條、old_text 空的都報錯", () => {
  assert.throws(() => applyChange(["甲"], { action: "remove", oldText: "丙" }, 100), /找不到含有「丙」的記憶。目前的記憶：\n- 甲/);
  assert.throws(() => applyChange([], { action: "remove", oldText: "丙" }, 100), /目前沒有任何記憶/);
  assert.throws(() => applyChange(["用戶甲", "用戶乙"], { action: "remove", oldText: "用戶" }, 100), /同時出現在 2 條記憶/);
  assert.throws(() => applyChange(["甲"], { action: "remove", oldText: "  " }, 100), /old_text 不能是空的/);
});

test("applyChange：完全相同的那條優先，不算對到好幾條", () => {
  assert.deepEqual(applyChange(["用戶", "用戶偏好"], { action: "remove", oldText: "用戶" }, 100), ["用戶偏好"]);
});

test("applyChange：超過上限拒絕，並列出現有記憶；剛好等於上限可以", () => {
  // 「- 甲\n」是 4 字
  assert.deepEqual(applyChange([], { action: "add", content: "甲" }, 4), ["甲"]);
  assert.throws(
    () => applyChange(["甲"], { action: "add", content: "乙" }, 4),
    /超過記憶上限：寫入後會是 8\/4 字，至少要騰出 4 字。[\s\S]*目前的記憶：\n- 甲/,
  );
  assert.throws(() => applyChange(["甲"], { action: "replace", oldText: "甲", content: "甲甲" }, 4), /超過記憶上限/);
});

test("applyChange：已經超過上限時（例如手動改過），remove 還是可以", () => {
  assert.deepEqual(applyChange(["很長的一條", "另一條"], { action: "remove", oldText: "另一條" }, 3), ["很長的一條"]);
});

test("describeChange：給用戶看的描述，修改和刪除顯示完整的原文", () => {
  const entries = ["用戶偏好簡潔的回覆"];
  assert.equal(describeChange(entries, { action: "add", content: "新的" }), "新增：新的");
  assert.equal(describeChange(entries, { action: "replace", oldText: "簡潔", content: "改過" }), "修改：用戶偏好簡潔的回覆\n改成：改過");
  assert.equal(describeChange(entries, { action: "remove", oldText: "簡潔" }), "刪除：用戶偏好簡潔的回覆");
});

test("parseChange：照 action 檢查必填欄位，add、replace 的內容加上分類標籤", () => {
  assert.deepEqual(parseChange({ action: "add", category: "偏好", content: "x" }), { action: "add", content: "[偏好] x" });
  assert.deepEqual(parseChange({ action: "replace", category: "經驗", old_text: "a", content: "b" }), {
    action: "replace",
    oldText: "a",
    content: "[經驗] b",
  });
  assert.deepEqual(parseChange({ action: "remove", old_text: "a" }), { action: "remove", oldText: "a" }, "remove 不用分類");
  assert.throws(() => parseChange({ action: "add", category: "知識" }), /要給 content/);
  assert.throws(() => parseChange({ action: "remove" }), /要給 old_text/);
  assert.throws(() => parseChange({ action: "patch" }), /不認識的 action：patch/);
});

test("parseChange：沒給分類或分類不對就報錯，提醒身份、人格、規則要改 IDENTITY.md", () => {
  assert.throws(() => parseChange({ action: "add", content: "x" }), /要給 category，只能是 偏好、知識、經驗。講你扮演誰、怎麼說話、要守什麼規則的不是記憶，要改 IDENTITY\.md/);
  assert.throws(() => parseChange({ action: "add", category: "身份", content: "x" }), /只能是 偏好、知識、經驗/);
});

test("withCategory：模型自己加的標籤、「- 」拿掉，換成指定的分類；空的回空字串", () => {
  assert.equal(withCategory("知識", "[偏好] 用戶在某公司"), "[知識] 用戶在某公司");
  assert.equal(withCategory("經驗", "- 踩過的坑"), "[經驗] 踩過的坑");
  assert.equal(withCategory("知識", "  "), "");
});

test("memory 工具 description：列出三個分類，說明身份、人格、規則要改 IDENTITY.md", () => {
  const description = createMemoryTool({ path: "x", approval: false, charLimit: 2200 }).spec.description;
  for (const name of ["偏好", "知識", "經驗"]) assert.match(description, new RegExp(`${name}：`));
  assert.match(description, /講你扮演誰（身份）、怎麼說話（人格）、要守什麼規則的，就算用戶沒說「改身份」，也要改 IDENTITY\.md/);
  assert.match(description, /拿不準就先問用戶/);
  assert.match(description, /寫成事實而不是命令/);
  assert.doesNotMatch(description, /system prompt 不會更新|下一段對話才會帶到/);
});

// ── 檔案 ──

test("readEntries / writeEntries：沒有檔案當作空的；寫入後讀得回來，不留暫存檔", () => {
  const path = tempMemory();
  assert.deepEqual(readEntries(path), []);
  writeEntries(path, ["甲", "乙"]);
  assert.equal(readFileSync(path, "utf8"), "- 甲\n- 乙\n");
  assert.deepEqual(readEntries(path), ["甲", "乙"]);
  assert.equal(existsSync(`${path}.tmp`), false);
});

// ── 工具 ──

test("memory 工具：直接寫入，結果提醒模型在回覆中告訴用戶", async () => {
  const path = tempMemory("- 舊的\n");
  const tool = createMemoryTool({ path, approval: false, charLimit: 2200 });
  const result = await tool.run({ action: "add", category: "偏好", content: "用戶偏好一題一題問" });
  assert.equal(readFileSync(path, "utf8"), "- 舊的\n- [偏好] 用戶偏好一題一題問\n");
  assert.match(result, /^已寫入。新增：\[偏好\] 用戶偏好一題一題問/);
  assert.match(result, /記憶目前 \d+\/2200 字/);
  assert.match(result, /請在回覆中告訴用戶記了什麼/);
  assert.doesNotMatch(result, /system prompt|下一段對話/, "不講內部機制");
});

test("memory 工具：直接寫入模式不問用戶", async () => {
  const path = tempMemory();
  const { context, asked } = fakeContext("denied");
  await createMemoryTool({ path, approval: false, charLimit: 2200 }).run({ action: "add", category: "知識", content: "甲" }, undefined, context);
  assert.deepEqual(asked, []);
  assert.deepEqual(readEntries(path), ["[知識] 甲"]);
});

test("memory 工具：不合法的變動丟錯，不寫檔", async () => {
  const path = tempMemory("- 甲\n");
  const tool = createMemoryTool({ path, approval: false, charLimit: 2200 });
  await assert.rejects(() => tool.run({ action: "remove", old_text: "丙" }), /找不到/);
  assert.equal(readFileSync(path, "utf8"), "- 甲\n");
});

test("memory 工具：核准模式，用戶核准才寫入，按鈕訊息寫出要做什麼", async () => {
  const path = tempMemory();
  const { context, asked } = fakeContext("approved");
  const result = await createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "add", category: "知識", content: "甲" }, undefined, context);
  assert.deepEqual(asked, ["🧠 想新增：[知識] 甲"]);
  assert.deepEqual(readEntries(path), ["[知識] 甲"]);
  assert.match(result, /^已寫入/);
});

test("memory 工具：核准模式，用戶拒絕就不寫，告訴模型不要再試", async () => {
  const path = tempMemory();
  const { context } = fakeContext("denied");
  const result = await createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "add", category: "知識", content: "甲" }, undefined, context);
  assert.deepEqual(readEntries(path), []);
  assert.match(result, /用戶拒絕了，未寫入。不要再試同一筆/);
});

test("memory 工具：核准模式，沒等到核准（新訊息、/stop）就不寫", async () => {
  const path = tempMemory();
  const { context } = fakeContext({ cancelled: "用戶傳了新訊息" });
  const result = await createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "add", category: "知識", content: "甲" }, undefined, context);
  assert.deepEqual(readEntries(path), []);
  assert.match(result, /沒有等到核准（用戶傳了新訊息），未寫入/);
});

test("memory 工具：核准模式，不合法的變動先擋掉，不用問用戶", async () => {
  const path = tempMemory();
  const { context, asked } = fakeContext("approved");
  await assert.rejects(
    () => createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "remove", old_text: "x" }, undefined, context),
    /找不到/,
  );
  assert.deepEqual(asked, []);
});

test("memory 工具：等核准期間檔案被改了，用最新的內容套用", async () => {
  const path = tempMemory("- 甲\n");
  const { context } = fakeContext(async () => {
    writeFileSync(path, "- 甲\n- 期間加的\n");
    return "approved";
  });
  await createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "add", category: "知識", content: "乙" }, undefined, context);
  assert.deepEqual(readEntries(path), ["甲", "期間加的", "[知識] 乙"]);
});

test("memory 工具：核准模式但沒有 context（沒辦法問用戶）就不寫", async () => {
  const path = tempMemory();
  await assert.rejects(() => createMemoryTool({ path, approval: true, charLimit: 2200 }).run({ action: "add", category: "知識", content: "甲" }), /沒有辦法詢問用戶/);
  assert.deepEqual(readEntries(path), []);
});

test("memory 工具 description：寫出上限，核准模式才提到核准", () => {
  const direct = createMemoryTool({ path: "x", approval: false, charLimit: 1234 }).spec.description;
  assert.match(direct, /整份記憶 1234 字/);
  assert.doesNotMatch(direct, /核准/);
  assert.match(createMemoryTool({ path: "x", approval: true, charLimit: 2200 }).spec.description, /寫入前會先請用戶核准/);
});
