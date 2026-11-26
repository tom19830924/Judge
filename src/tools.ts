import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolSpec } from "./types.ts";
import { truncate } from "./util.ts";

/** 核准的結果：approved 核准、denied 拒絕，cancelled 是沒等到（新訊息、/stop、不支援按鈕） */
export type ApprovalAnswer = "approved" | "denied" | { cancelled: string };

/** 問用戶選項的結果：chosen 是選項文字，cancelled 是沒等到（新訊息、/stop、不支援按鈕） */
export type AskAnswer = { chosen: string } | { cancelled: string };

/** agent 執行工具時提供的環境：哪個聊天室、怎麼問用戶 */
export type ToolContext = {
  chatId: string;
  /** 在聊天室送出核准、拒絕按鈕，等用戶按。signal 中止時馬上回 cancelled */
  requestApproval(text: string, signal?: AbortSignal): Promise<ApprovalAnswer>;
  /** 在聊天室送出選項按鈕，等用戶按。signal 中止時馬上回 cancelled */
  askUser(question: string, options: string[], signal?: AbortSignal): Promise<AskAnswer>;
};

/** signal 中止時（用戶 /stop），會跑很久的工具要盡快停下來；很快就做完的工具可以不理 */
export type Tool = {
  spec: ToolSpec;
  run(input: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<string>;
};

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
/** 送 SIGTERM 後給程式收尾的時間，超過就 SIGKILL */
export const KILL_GRACE_MS = 1500;

/**
 * @param workdir 相對路徑和指令的起點
 * @param secretEnvKeys 不傳給子程序的環境變數（API key、bot token 等）
 */
export function createTools(workdir: string, secretEnvKeys: readonly string[]): Tool[] {
  const pathOf = (input: Record<string, unknown>) => resolve(workdir, stringArg(input, "path"));
  const childEnv = { ...process.env };
  for (const key of secretEnvKeys) delete childEnv[key];

  return [
    {
      spec: {
        name: "read_file",
        description: "讀取文字檔內容。path 可以是相對於工作目錄的路徑。",
        inputSchema: schema({ path: "檔案路徑" }),
      },
      run: async (input) => truncate(await readFile(pathOf(input), "utf8")),
    },
    {
      spec: {
        name: "write_file",
        description: "建立或整個覆寫檔案，會自動建立不存在的資料夾。只改一小段時請用 edit_file。",
        inputSchema: schema({ path: "檔案路徑", content: "完整的檔案內容" }),
      },
      run: async (input) => {
        const file = pathOf(input);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, stringArg(input, "content"));
        return `已寫入 ${file}`;
      },
    },
    {
      spec: {
        name: "edit_file",
        description: "把檔案中的 old_text 換成 new_text。old_text 必須在檔案中剛好出現一次，包含空白和縮排都要完全一致。",
        inputSchema: schema({ path: "檔案路徑", old_text: "要被取代的原文", new_text: "取代後的內容" }),
      },
      run: async (input) => {
        const file = pathOf(input);
        const oldText = stringArg(input, "old_text");
        const content = await readFile(file, "utf8");
        const count = content.split(oldText).length - 1;
        if (count !== 1) throw new Error(`old_text 在檔案中出現 ${count} 次，必須剛好 1 次`);
        await writeFile(file, content.replace(oldText, () => stringArg(input, "new_text")));
        return `已修改 ${file}`;
      },
    },
    {
      spec: {
        name: "run_command",
        description: `在工作目錄用 bash 執行指令，回傳輸出和結束碼。沒有 stdin，不能執行需要互動輸入的指令。預設逾時 ${DEFAULT_TIMEOUT_SECONDS} 秒，最多 ${MAX_TIMEOUT_SECONDS} 秒。`,
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "要執行的 bash 指令" },
            timeout_seconds: { type: "number", description: "逾時秒數" },
          },
          required: ["command"],
        },
      },
      run: (input, signal) => {
        const requested = typeof input["timeout_seconds"] === "number" ? input["timeout_seconds"] : DEFAULT_TIMEOUT_SECONDS;
        const timeout = Math.min(Math.max(requested, 1), MAX_TIMEOUT_SECONDS);
        return runCommand(stringArg(input, "command"), workdir, childEnv, timeout, signal);
      },
    },
    {
      spec: {
        name: "ask_user",
        description:
          "問用戶一個問題，並附上幾個選項，用戶在聊天室直接按按鈕選。" +
          "需要用戶做決定時優先用這個，不要讓他打字。一次只問一個問題，最多 20 個選項。" +
          "用戶也可能不按、改用打字回覆，這時會回「已取消」，照他說的做就好。",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "問題，一句話講完" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "選項文字，每個 60 字以內，按鈕上直接顯示",
            },
          },
          required: ["question", "options"],
        },
      },
      run: async (input, signal, context) => {
        if (!context) throw new Error("這個環境不支援問用戶");
        const options = stringArrayArg(input, "options");
        if (options.length === 0) throw new Error("options 不能是空的");
        const answer = await context.askUser(stringArg(input, "question"), options, signal);
        return "chosen" in answer ? `用戶選了：${answer.chosen}` : `用戶沒有選（${answer.cancelled}）`;
      },
    },
  ];
}

function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise) => {
    // detached：自成一個程序群組，終止時連它叫出來的子程序一起停，不留孤兒程序
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stopReason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    /** 先 SIGTERM 讓程式自己收尾，過了寬限時間還在就 SIGKILL */
    const stop = (reason: string) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop(`逾時（${timeoutSeconds} 秒）已終止`), timeoutSeconds * 1000);
    const onAbort = () => stop("已被用戶中止");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanup();
      resolvePromise(`無法執行：${error.message}`);
    });
    // close 要等 stdout/stderr 都關閉；子程序還開著管線時，整個群組都結束才會觸發
    child.on("close", (code, exitSignal) => {
      cleanup();
      const status = stopReason ?? `結束碼 ${code ?? exitSignal}`;
      resolvePromise(`${truncate(output) || "（沒有輸出）"}\n[${status}]`);
    });
  });
}

/** 送訊號給整個程序群組。程序已經結束時會失敗，忽略即可 */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // 已經結束了
  }
}

function schema(properties: Record<string, string>): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [name, { type: "string", description }]),
    ),
    required: Object.keys(properties),
  };
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`參數 ${key} 必須是字串`);
  return value;
}

function stringArrayArg(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`參數 ${key} 必須是字串陣列`);
  }
  return value as string[];
}
