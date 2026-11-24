// 上下文上限：API 不會告訴我們上限，也不會預先警告，只能自己判斷。
// 參考 Hermes 的 agent/model_metadata.py，只取「設定檔指定 → 內建對照表 → 預設值」和「從錯誤訊息抓上限」。

/** 超過上限的這個比例就提醒用戶開新的一段 */
export const WARN_RATIO = 0.8;

const DEFAULT_CONTEXT_WINDOW = 200_000;

// 用模型名稱的片段比對，取最長的符合項（"claude-opus-5" 比 "claude" 優先）
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5": 1_000_000,
  claude: 200_000,
};

/** 設定檔有寫就用設定檔，沒寫就查對照表，都沒有就用預設值 */
export function resolveContextWindow(model: string, configured: string | undefined): number {
  if (configured !== undefined) {
    const value = Number(configured);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`上下文上限必須是正整數：${configured}`);
    return value;
  }
  const name = model.toLowerCase();
  const match = Object.keys(KNOWN_CONTEXT_WINDOWS)
    .filter((key) => name.includes(key))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined ? DEFAULT_CONTEXT_WINDOW : (KNOWN_CONTEXT_WINDOWS[match] ?? DEFAULT_CONTEXT_WINDOW);
}

/** 對話超過模型上限，API 拒絕了。limit 是從錯誤訊息抓出來的實際上限，抓不到就是 null */
export class ContextTooLongError extends Error {
  readonly limit: number | null;
  constructor(detail: string) {
    super(`對話超過模型的上下文上限：${detail}`);
    this.name = "ContextTooLongError";
    this.limit = parseContextLimit(detail);
  }
}

export function isContextTooLong(detail: string): boolean {
  return /prompt is too long|context (length|window)|too many (input )?tokens|maximum context/i.test(detail);
}

/** 例如「prompt is too long: 210000 tokens > 200000 maximum」→ 200000 */
function parseContextLimit(detail: string): number | null {
  const text = detail.toLowerCase();
  const patterns = [/>\s*(\d{4,})\s*(?:max|limit|token)/, /(\d{4,})\s*maximum/, /(?:maximum|max|limit)[^\d]{0,30}(\d{4,})/];
  for (const pattern of patterns) {
    const value = Number(pattern.exec(text)?.[1]);
    if (Number.isInteger(value) && value >= 1024 && value <= 10_000_000) return value;
  }
  return null;
}
