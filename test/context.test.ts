import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextTooLongError, isContextTooLong, resolveContextWindow, WARN_RATIO } from "../src/context.ts";

test("resolveContextWindow：設定檔有寫就用設定檔的值", () => {
  assert.equal(resolveContextWindow("claude-opus-5-5", "200000"), 200_000);
});

test("resolveContextWindow：設定檔的值不是正整數就報錯", () => {
  assert.throws(() => resolveContextWindow("claude-opus-5-5", "0"), /正整數/);
  assert.throws(() => resolveContextWindow("claude-opus-5-5", "-1"), /正整數/);
  assert.throws(() => resolveContextWindow("claude-opus-5-5", "abc"), /正整數/);
  assert.throws(() => resolveContextWindow("claude-opus-5-5", "1.5"), /正整數/);
});

test("resolveContextWindow：沒設定時依模型名稱比對，取最長的符合項", () => {
  // claude-opus-5 同時符合 "claude" 和 "claude-opus-5"，要取後者（百萬）
  assert.equal(resolveContextWindow("claude-opus-5-5", undefined), 1_000_000);
  assert.equal(resolveContextWindow("claude-sonnet-4-5", undefined), 200_000);
});

test("resolveContextWindow：比對不分大小寫", () => {
  assert.equal(resolveContextWindow("Claude-Opus-5-5", undefined), 1_000_000);
});

test("resolveContextWindow：不認識的模型用預設 20 萬", () => {
  assert.equal(resolveContextWindow("gpt-5", undefined), 200_000);
});

test("isContextTooLong：認得各種超長的錯誤訊息", () => {
  assert.ok(isContextTooLong("prompt is too long: 210000 tokens > 200000 maximum"));
  assert.ok(isContextTooLong("maximum context length exceeded"));
  assert.ok(!isContextTooLong("invalid api key"));
  assert.ok(!isContextTooLong("rate limit"));
});

test("ContextTooLongError：從錯誤訊息抓出實際上限", () => {
  const error = new ContextTooLongError("prompt is too long: 210000 tokens > 200000 maximum");
  assert.equal(error.limit, 200_000);
  assert.ok(error instanceof ContextTooLongError);
});

test("ContextTooLongError：抓不到上限時 limit 為 null", () => {
  assert.equal(new ContextTooLongError("context window exceeded").limit, null);
});

test("WARN_RATIO 是 0.8", () => {
  assert.equal(WARN_RATIO, 0.8);
});
