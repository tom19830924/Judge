import assert from "node:assert/strict";
import { test } from "node:test";
import { findChannel } from "../src/channels/index.ts";
import { findProvider } from "../src/providers/index.ts";

test("findProvider：找得到 mixroute，不認識的報錯", () => {
  assert.equal(findProvider("mixroute").id, "mixroute");
  assert.throws(() => findProvider("不存在"), /不認識的模型服務商/);
});

test("findChannel：找得到 telegram，不認識的報錯", () => {
  assert.equal(findChannel("telegram").id, "telegram");
  assert.throws(() => findChannel("不存在"), /不認識的通訊軟體/);
});
