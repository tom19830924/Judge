import assert from "node:assert/strict";
import { test } from "node:test";
import { filterModels, groupModels, OTHER_VENDOR, vendorOf } from "../src/models.ts";

test("vendorOf：常見前綴對到廠商，不分大小寫", () => {
  assert.equal(vendorOf("claude-opus-5-5"), "Anthropic");
  assert.equal(vendorOf("gpt-5.2"), "OpenAI");
  assert.equal(vendorOf("GPT-4o"), "OpenAI");
  assert.equal(vendorOf("o3-mini"), "OpenAI");
  assert.equal(vendorOf("gemini-3.1-flash-lite"), "Google");
  assert.equal(vendorOf("grok-4"), "xAI");
  assert.equal(vendorOf("deepseek-v3"), "DeepSeek");
});

test("vendorOf：認不出來的歸到「其他」，不硬猜", () => {
  assert.equal(vendorOf("some-new-model"), OTHER_VENDOR);
  assert.equal(vendorOf(""), OTHER_VENDOR);
});

test("vendorOf：前綴要接分隔符，不會誤判只是開頭相同的名字", () => {
  assert.equal(vendorOf("o3-pro"), "OpenAI");
  assert.equal(vendorOf("o3mini"), OTHER_VENDOR, "沒有分隔符就不算");
  assert.equal(vendorOf("gemma-3"), "Google");
});

test("groupModels：依廠商分組，模型保持原順序", () => {
  const groups = groupModels(["gpt-5", "claude-opus-5", "gpt-4o", "claude-haiku-5-5", "gpt-5-mini"]);
  assert.deepEqual(groups, [
    { vendor: "OpenAI", models: ["gpt-5", "gpt-4o", "gpt-5-mini"] },
    { vendor: "Anthropic", models: ["claude-opus-5", "claude-haiku-5-5"] },
  ]);
});

test("groupModels：廠商照數量多到少排，一樣多照名稱，「其他」放最後", () => {
  const groups = groupModels(["mystery-1", "gpt-5", "gemini-3", "gpt-4o", "claude-opus-5", "grok-4"]);
  assert.deepEqual(groups.map((group) => group.vendor), ["OpenAI", "Anthropic", "Google", "xAI", OTHER_VENDOR]);
});

test("groupModels：重複的名稱只留一個，空字串忽略", () => {
  assert.deepEqual(groupModels(["gpt-5", "gpt-5", "", "gpt-4o"]), [{ vendor: "OpenAI", models: ["gpt-5", "gpt-4o"] }]);
});

test("filterModels：不分大小寫的子字串比對，空關鍵字回全部", () => {
  const models = ["claude-opus-5-5", "gpt-5.2", "gemini-3.1-flash-lite"];
  assert.deepEqual(filterModels(models, "OPUS"), ["claude-opus-5-5"]);
  assert.deepEqual(filterModels(models, "flash"), ["gemini-3.1-flash-lite"]);
  assert.deepEqual(filterModels(models, " "), models);
  assert.deepEqual(filterModels(models, "沒有這個"), []);
});
