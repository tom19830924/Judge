import { requireSetting } from "../config.ts";
import type { ProviderDefinition } from "../types.ts";
import { createAnthropicMessagesClient } from "./anthropic-messages.ts";

export const mixroute: ProviderDefinition = {
  id: "mixroute",
  displayName: "mixroute（Anthropic Messages 相容閘道）",
  fields: [
    { key: "MIXROUTE_API_KEY", label: "mixroute API key", secret: true },
    { key: "baseUrl", label: "API 網址", secret: false, default: "https://api.mixroute.ai" },
    { key: "model", label: "模型", secret: false, default: "claude-opus-5-5" },
  ],
  create: (settings) =>
    createAnthropicMessagesClient({
      baseUrl: requireSetting(settings, "baseUrl"),
      apiKey: requireSetting(settings, "MIXROUTE_API_KEY"),
      model: requireSetting(settings, "model"),
      maxTokens: 16_000,
      // PROMPT_CACHE=off 可以關掉快取（例如閘道的快取出問題時）
      promptCache: process.env.PROMPT_CACHE !== "off",
    }),
};
