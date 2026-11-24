import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_MEMORY_CHAR_LIMIT } from "./memory.ts";
import type { Settings, SetupField } from "./types.ts";

export type Selection = { id: string; settings: Settings };
/** 代理人資料夾的 config.json。工作目錄不在這裡設定，用啟動時的目錄 */
export type Config = { provider: Selection; channel: Selection; memory?: MemoryConfig };
/** 記憶設定，都可以不寫。approval：寫入前先問用戶（預設 false）；charLimit：MEMORY.md 字數上限（預設 2200） */
export type MemoryConfig = { approval?: boolean; charLimit?: number };

/** 讀代理人的 .env。專案根目錄的 .env 不讀 */
export function loadEnv(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readConfig(path: string): Config | undefined {
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  if (!config.provider || !config.channel) throw new Error(`${path} 缺少 provider 或 channel，請執行 npm run setup`);
  return config as Config;
}

/** setup 用：讀之前的設定當預設值，缺欄位也沒關係 */
export function readConfigDraft(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
}

/** config.json 的 memory 段落補上預設值；型別不對就報錯，不要默默用預設值 */
export function resolveMemoryConfig(memory: unknown, path = "config.json"): Required<MemoryConfig> {
  if (memory === undefined) return { approval: false, charLimit: DEFAULT_MEMORY_CHAR_LIMIT };
  if (typeof memory !== "object" || memory === null || Array.isArray(memory)) throw new Error(`${path} 的 memory 必須是物件`);
  const { approval = false, charLimit = DEFAULT_MEMORY_CHAR_LIMIT } = memory as Record<string, unknown>;
  if (typeof approval !== "boolean") throw new Error(`${path} 的 memory.approval 必須是 true 或 false`);
  if (typeof charLimit !== "number" || !Number.isInteger(charLimit) || charLimit <= 0) {
    throw new Error(`${path} 的 memory.charLimit 必須是正整數`);
  }
  return { approval, charLimit };
}

export function writeConfig(config: Config, path: string): void {
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** 只更新指定的變數，.env 裡的其他內容原樣保留 */
export function updateEnvFile(values: Record<string, string>, path: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  while (lines.at(-1) === "") lines.pop();

  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    const value = key === undefined ? undefined : pending.get(key);
    if (key === undefined || value === undefined) return line;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);

  writeFileSync(path, updated.join("\n") + "\n");
  chmodSync(path, 0o600);
}

/** 依欄位定義組出完整設定：機密從環境變數拿，其他從設定檔拿，缺任何一項就報錯 */
export function resolveSettings(fields: SetupField[], stored: Settings, setupCommand = "npm run setup"): Settings {
  const settings: Settings = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = field.secret ? process.env[field.key] : (stored[field.key] ?? field.default);
    if (value === undefined || value === "") missing.push(field.label);
    else settings[field.key] = value;
  }
  if (missing.length > 0) throw new Error(`缺少設定：${missing.join("、")}。請執行 ${setupCommand}`);
  return settings;
}

export function requireSetting(settings: Settings, key: string): string {
  const value = settings[key];
  if (value === undefined) throw new Error(`缺少設定：${key}`);
  return value;
}
