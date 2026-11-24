import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicMessagesClient, fromWire, toWireMessage, withCacheMarkers } from "../../src/providers/anthropic-messages.ts";
import type { Message } from "../../src/types.ts";

test("fromWire：text 與 tool_use 轉成內部格式", () => {
  const response = fromWire({
    content: [
      { type: "text", text: "我先看一下" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
    ],
    stop_reason: "tool_use",
  });
  assert.deepEqual(response.content, [
    { type: "text", text: "我先看一下" },
    { type: "tool_call", id: "t1", name: "read_file", input: { path: "a" } },
  ]);
  assert.equal(response.stopReason, "tool_use");
});

test("fromWire：空內容時 content 為空陣列、保留原始 stop_reason", () => {
  const response = fromWire({ content: [], stop_reason: "refusal" });
  assert.deepEqual(response.content, []);
  assert.equal(response.stopReason, "other", "未知原因歸類成 other");
  assert.equal(response.rawStopReason, "refusal", "原始字串要留著才查得出是婉拒");
});

test("fromWire：空字串的 text block 會被丟掉", () => {
  const response = fromWire({ content: [{ type: "text", text: "" }], stop_reason: "end_turn" });
  assert.deepEqual(response.content, []);
});

test("fromWire：stop_reason 歸類", () => {
  assert.equal(fromWire({ content: [], stop_reason: "end_turn" }).stopReason, "end");
  assert.equal(fromWire({ content: [], stop_reason: "max_tokens" }).stopReason, "max_tokens");
  assert.equal(fromWire({ content: [], stop_reason: null }).stopReason, "other");
});

test("fromWire：usage 把快取讀寫一起算進 inputTokens", () => {
  const response = fromWire({
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 30 },
  });
  assert.deepEqual(response.usage, { inputTokens: 180, outputTokens: 20, cacheWriteTokens: 50, cacheReadTokens: 30 });
});

test("fromWire：沒有 usage 時為 null", () => {
  assert.equal(fromWire({ content: [], stop_reason: "end_turn" }).usage, null);
});

test("toWireMessage：工具結果轉成 Anthropic 的 tool_result 欄位", () => {
  const wire = toWireMessage({
    role: "user",
    content: [{ type: "tool_result", toolCallId: "t1", content: "結果", isError: true }],
  });
  assert.deepEqual(wire, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "結果", is_error: true }],
  });
});

test("toWireMessage：工具呼叫轉成 tool_use", () => {
  const wire = toWireMessage({
    role: "assistant",
    content: [{ type: "tool_call", id: "t1", name: "read_file", input: { path: "a" } }],
  });
  assert.deepEqual(wire.content, [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }]);
});

// ── prompt caching ──

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const CACHE = { type: "ephemeral" };

test("withCacheMarkers：只標最後兩則用戶訊息的最後一個 block", () => {
  const messages = [
    user("一"),
    assistant("a"),
    user("二"),
    assistant("b"),
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, toolCallId: "t1", content: "x", isError: false },
        { type: "text" as const, text: "三" },
      ],
    },
  ].map(toWireMessage);
  const marked = withCacheMarkers(messages);

  const markers = marked.map((message) => message.content.map((block) => "cache_control" in block));
  assert.deepEqual(markers, [[false], [false], [true], [false], [false, true]]);
  assert.deepEqual((marked[4]!.content[1] as { cache_control?: unknown }).cache_control, CACHE);
  assert.equal("cache_control" in messages[2]!.content[0]!, false, "不能改到原本的物件");
});

test("withCacheMarkers：只有一則用戶訊息時只標一個", () => {
  const marked = withCacheMarkers([user("hi")].map(toWireMessage));
  assert.deepEqual(marked[0]!.content[0], { type: "text", text: "hi", cache_control: CACHE });
});

/** 用假的 fetch 攔下送出的 body */
async function captureBody(options: { promptCache?: boolean }, tools: boolean): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const client = createAnthropicMessagesClient({ baseUrl: "http://x", apiKey: "k", model: "m", maxTokens: 10, ...options });
    await client.complete({
      system: "規則",
      messages: [user("hi")],
      tools: tools ? [{ name: "t", description: "d", inputSchema: {} }] : [],
    });
  } finally {
    globalThis.fetch = original;
  }
  return body;
}

test("complete：預設在 system prompt 和訊息上標記快取", async () => {
  const body = await captureBody({}, true);
  assert.deepEqual(body.system, [{ type: "text", text: "規則", cache_control: CACHE }]);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hi", cache_control: CACHE }] }]);
});

test("complete：promptCache 關掉時不標記", async () => {
  const body = await captureBody({ promptCache: false }, true);
  assert.equal(body.system, "規則");
  assert.equal(JSON.stringify(body.messages).includes("cache_control"), false);
});

test("complete：沒帶工具的一次性請求不標記", async () => {
  const body = await captureBody({}, false);
  assert.equal(body.system, "規則");
  assert.equal(JSON.stringify(body.messages).includes("cache_control"), false);
});
