import type { Block, Message, ModelClient, ModelResponse, StopReason, Usage } from "../types.ts";
import { ContextTooLongError, isContextTooLong } from "../context.ts";
import { setTimeout as delay } from "node:timers/promises";

type Options = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** 是否標記 prompt caching 斷點，預設開啟 */
  promptCache?: boolean;
};

const CACHE = { type: "ephemeral" } as const;

type WireBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
type WireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
type WireResponse = { content: WireBlock[]; stop_reason: string | null; usage?: WireUsage };

/** Anthropic Messages API 格式的用戶端。凡是相容這個格式的服務商都能共用 */
export function createAnthropicMessagesClient(options: Options): ModelClient {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  return {
    model: options.model,
    async complete(request) {
      // 沒帶工具的是一次性請求（例如 /rename 取名稱），之後不會再讀到，標記只會白付寫入費
      const cache = (options.promptCache ?? true) && request.tools.length > 0;
      const messages = request.messages.map(toWireMessage);
      const body = {
        model: options.model,
        max_tokens: options.maxTokens,
        system: cache ? [{ type: "text", text: request.system, cache_control: CACHE }] : request.system,
        messages: cache ? withCacheMarkers(messages) : messages,
        // 沒有工具時整個欄位不送（例如 /rename 取名稱），有些閘道不接受空陣列
        ...(request.tools.length > 0 && {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
      };
      return fromWire((await post(url, options.apiKey, body, request.signal)) as WireResponse);
    },
  };
}

async function post(url: string, apiKey: string, body: unknown, cancel?: AbortSignal): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(10 * 60_000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
    });
    if (response.ok) return response.json();

    const detail = (await response.text()).slice(0, 500);
    if (response.status === 400 && isContextTooLong(detail)) throw new ContextTooLongError(detail);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 3) throw new Error(`模型 API 錯誤 ${response.status}：${detail}`);
    // 等待重試期間被取消也要馬上停
    await delay(2 ** attempt * 1000, undefined, { signal: cancel });
  }
}

type WireMessage = ReturnType<typeof toWireMessage>;

/**
 * 在最後兩則用戶訊息的最後一個 block 標記快取斷點（system prompt 那個另外標）。
 * 最後一則讓下一次請求能讀到到目前為止的整段對話；倒數第二則就是上一次請求的結尾，
 * 確保這次一定讀得到上次寫入的快取（Anthropic 只往回找 20 個 block，一次很多工具呼叫時可能找不到）。
 * 加上 system 一共 3 個，上限是 4 個
 */
export function withCacheMarkers(messages: WireMessage[]): WireMessage[] {
  const marked = new Set(
    messages
      .map((message, index) => (message.role === "user" ? index : -1))
      .filter((index) => index >= 0)
      .slice(-2),
  );
  return messages.map((message, index) => {
    if (!marked.has(index) || message.content.length === 0) return message;
    const content = message.content.map((block, i) => (i === message.content.length - 1 ? { ...block, cache_control: CACHE } : block));
    return { ...message, content };
  });
}

export function toWireMessage(message: Message) {
  const blocks: readonly Block[] = message.content;
  return { role: message.role, content: blocks.map(toWireBlock) };
}

function toWireBlock(block: Block) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError };
  }
}

export function fromWire(wire: WireResponse): ModelResponse {
  const content: ModelResponse["content"] = [];
  for (const block of wire.content) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "tool_use" && block.id && block.name) {
      content.push({ type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return { content, stopReason: toStopReason(wire.stop_reason), rawStopReason: wire.stop_reason, usage: toUsage(wire.usage) };
}

/** 用了快取的話，input_tokens 只算沒命中快取的部分，三個加起來才是這次送進去的總量 */
function toUsage(usage: WireUsage | undefined): Usage | null {
  if (typeof usage?.input_tokens !== "number") return null;
  return {
    inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}
