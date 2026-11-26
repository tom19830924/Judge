// /model 選單用：把服務商回傳的模型清單依廠商分組。純字串處理，不碰網路。

/** 一個廠商的模型。models 保持服務商回傳的順序 */
export type ModelGroup = { vendor: string; models: string[] };

/**
 * 模型名稱前綴 → 廠商。由上往下比對，取第一個符合的。
 * 認不出來的歸到「其他」，不要硬猜，免得列表裡少了可用的模型
 */
const VENDOR_PREFIXES: [prefix: string, vendor: string][] = [
  ["claude", "Anthropic"],
  ["gpt", "OpenAI"],
  ["o1", "OpenAI"],
  ["o3", "OpenAI"],
  ["o4", "OpenAI"],
  ["chatgpt", "OpenAI"],
  ["davinci", "OpenAI"],
  ["babbage", "OpenAI"],
  ["whisper", "OpenAI"],
  ["sora", "OpenAI"],
  ["dall-e", "OpenAI"],
  ["text-embedding", "OpenAI"],
  ["gemini", "Google"],
  ["imagen", "Google"],
  ["veo", "Google"],
  ["gemma", "Google"],
  ["grok", "xAI"],
  ["llama", "Meta"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["kimi", "Moonshot"],
  ["glm", "Zhipu"],
  ["mistral", "Mistral"],
  ["codestral", "Mistral"],
  ["magistral", "Mistral"],
];

export const OTHER_VENDOR = "其他";

export function vendorOf(model: string): string {
  const name = model.toLowerCase();
  for (const [prefix, vendor] of VENDOR_PREFIXES) {
    // 前綴後面要是分隔符或結尾，"o1" 才不會吃到 "o1abc" 之外的東西
    if (name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}_`)) {
      return vendor;
    }
  }
  return OTHER_VENDOR;
}

/**
 * 依廠商分組。廠商照模型數量由多到少排，數量一樣照名稱；「其他」固定放最後。
 * 重複的模型名稱只留一個
 */
export function groupModels(models: readonly string[]): ModelGroup[] {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const model of models) {
    if (model === "" || seen.has(model)) continue;
    seen.add(model);
    const vendor = vendorOf(model);
    const list = groups.get(vendor);
    if (list) list.push(model);
    else groups.set(vendor, [model]);
  }
  return [...groups]
    .map(([vendor, list]) => ({ vendor, models: list }))
    .sort((a, b) => {
      if (a.vendor === OTHER_VENDOR) return 1;
      if (b.vendor === OTHER_VENDOR) return -1;
      return b.models.length - a.models.length || a.vendor.localeCompare(b.vendor);
    });
}

/** /model 關鍵字：不分大小寫的子字串比對 */
export function filterModels(models: readonly string[], keyword: string): string[] {
  const needle = keyword.trim().toLowerCase();
  if (needle === "") return [...models];
  return models.filter((model) => model.toLowerCase().includes(needle));
}
