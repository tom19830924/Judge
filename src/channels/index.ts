import type { ChannelDefinition } from "../types.ts";
import { telegram } from "./telegram.ts";

/** 新增通訊軟體：在 channels/ 加一個檔案，再登記到這裡 */
export const channels: readonly ChannelDefinition[] = [telegram];

export function findChannel(id: string): ChannelDefinition {
  const channel = channels.find((candidate) => candidate.id === id);
  if (!channel) throw new Error(`不認識的通訊軟體：${id}。請執行 npm run setup`);
  return channel;
}
