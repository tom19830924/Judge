import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/prompt.ts";

const base = {
  identity: "你是測試代理人。\n\n## 專屬規則\n- 規則一",
  identityPath: "/j/agents/a/IDENTITY.md",
  memory: "",
  workdir: "/work",
  channelName: "Telegram",
};

test("buildSystemPrompt：身分在最前面，接著通用規則，填入工作目錄和通訊軟體", () => {
  const prompt = buildSystemPrompt(base);
  assert.ok(prompt.startsWith("你是測試代理人。"));
  assert.ok(prompt.indexOf("## 專屬規則") < prompt.indexOf("## 回覆"));
  assert.ok(prompt.indexOf("## 回覆") < prompt.indexOf("## 工具"));
  assert.match(prompt, /用戶透過 Telegram 跟你對話/);
  assert.match(prompt, /工作目錄是 \/work。/);
});

test("buildSystemPrompt：寫明 IDENTITY.md 的路徑，講到身份、人格、規則就改它，不用 memory 記", () => {
  const prompt = buildSystemPrompt(base);
  assert.match(prompt, /## 關於 IDENTITY\.md\n- 開頭的身份、人格、規則來自 \/j\/agents\/a\/IDENTITY\.md。/);
  assert.match(prompt, /就改這個檔對應的段落，不要用 memory 記。用戶沒講到就不要改。/);
  assert.ok(prompt.indexOf("## 工具") < prompt.indexOf("## 關於 IDENTITY.md") && prompt.indexOf("## 關於 IDENTITY.md") < prompt.indexOf("## 記憶"));
});

test("buildSystemPrompt：不講 reload、凍結這些內部機制（改完當下就照新的做）", () => {
  const prompt = buildSystemPrompt(base);
  assert.doesNotMatch(prompt, /reload_prompt|才會生效|快照/);
});

test("buildSystemPrompt：通用部分不含任何代理人的身分", () => {
  const prompt = buildSystemPrompt({ ...base, identity: "X" });
  assert.doesNotMatch(prompt, /judge-dev/);
  assert.doesNotMatch(prompt, /自我開發/);
});

test("buildSystemPrompt：記憶段落在最後，只放 MEMORY.md 的內容（用法寫在 memory 工具）", () => {
  const prompt = buildSystemPrompt({ ...base, memory: "- [偏好] 用戶喜歡簡潔。\n" });
  assert.ok(prompt.endsWith("## 記憶\n- [偏好] 用戶喜歡簡潔。"));
});

test("buildSystemPrompt：記憶是空的，註明目前沒有記憶", () => {
  for (const memory of ["", "  \n"]) assert.ok(buildSystemPrompt({ ...base, memory }).endsWith("## 記憶\n目前沒有任何記憶。"));
});

test("buildSystemPrompt：同樣的輸入產生同樣的內容（凍結比對靠這個）", () => {
  assert.equal(buildSystemPrompt(base), buildSystemPrompt({ ...base }));
});
