import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMessage, truncate } from "../src/util.ts";

test("errorMessage：Error 取 message，其他轉字串", () => {
  assert.equal(errorMessage(new Error("壞了")), "壞了");
  assert.equal(errorMessage("只是字串"), "只是字串");
  assert.equal(errorMessage(42), "42");
});

test("truncate：沒超過上限原樣回傳", () => {
  assert.equal(truncate("短短的", 100), "短短的");
  const exact = "a".repeat(50);
  assert.equal(truncate(exact, 50), exact);
});

test("truncate：超過上限保留頭尾、中間省略", () => {
  const text = "a".repeat(100) + "b".repeat(100);
  const result = truncate(text, 100);
  assert.ok(result.startsWith("a".repeat(50)), "保留開頭");
  assert.ok(result.endsWith("b".repeat(50)), "保留結尾");
  assert.ok(result.includes("省略 100 字"), "標示省略字數");
  assert.ok(result.length < text.length);
});
