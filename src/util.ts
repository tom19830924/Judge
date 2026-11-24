export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 過長的文字保留頭尾，中間省略 */
export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…（省略 ${text.length - max} 字）…\n${text.slice(-half)}`;
}
