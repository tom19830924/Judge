import type { ProviderDefinition } from "../types.ts";
import { mixroute } from "./mixroute.ts";

/** 新增服務商：在 providers/ 加一個檔案，再登記到這裡 */
export const providers: readonly ProviderDefinition[] = [mixroute];

export function findProvider(id: string): ProviderDefinition {
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`不認識的模型服務商：${id}。請執行 npm run setup`);
  return provider;
}
