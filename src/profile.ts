import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Profile：一個資料夾就是一個代理人。程式本身通用，換資料夾就換身分。
 *
 * judge 資料夾在哪，依序找：
 *   1. 執行的資料夾/judge.config.json 的 home（只看這一層，不往上找）
 *   2. ~/.judge/config.json 的 home
 *   3. 預設 ~/.judge
 *
 *   <home>/agents/<name>/
 *     IDENTITY.md                 身份、人格、規則；第一次寫入預設身分，之後透過對話修改
 *     MEMORY.md                   記憶，用 memory 工具寫
 *     config.json                 模型、通訊軟體、記憶設定
 *     .env                        機密
 *     judge.db                    對話紀錄
 *     judge.pid                   正在跑的程式（防止同一個代理人跑兩個）
 */

export const DEFAULT_HOME = "~/.judge";
/** 專案層設定檔的名字，放在執行的資料夾 */
export const PROJECT_CONFIG_NAME = "judge.config.json";
/** 用戶層設定檔，固定在 ~/.judge/config.json（不能放在 home 裡，否則要先知道 home 才找得到它） */
export const USER_CONFIG_PATH = join(DEFAULT_HOME, "config.json");

/** 「setup」是子指令，不能當名字 */
const RESERVED_NAMES = new Set(["setup"]);
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type AgentPaths = {
  name: string;
  dir: string;
  identity: string;
  memory: string;
  config: string;
  env: string;
  db: string;
  pid: string;
};

/** ~ 開頭的換成家目錄，相對路徑以 base 為起點 */
export function expandPath(path: string, base: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(base, path);
}

/** judge 資料夾在哪，以及是從哪裡決定的（source：設定檔路徑，或「預設」） */
export type JudgeHome = { path: string; source: string };

export function judgeHomeText(judgeHome: JudgeHome): string {
  return `judge 資料夾：${judgeHome.path}（${judgeHome.source === "預設" ? "預設" : `來自 ${judgeHome.source}`}）`;
}

/** 讀設定檔的 home。檔案不存在或沒寫 home 回 undefined；相對路徑以設定檔所在的資料夾為起點 */
function readHome(configPath: string, home: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { home?: unknown };
  if (parsed.home === undefined) return undefined;
  if (typeof parsed.home !== "string" || parsed.home.trim() === "") {
    throw new Error(`${configPath} 的 home 必須是非空字串`);
  }
  return expandPath(parsed.home.trim(), resolve(configPath, ".."), home);
}

/**
 * judge 資料夾的位置：執行的資料夾的 judge.config.json → ~/.judge/config.json → 預設 ~/.judge。
 * 跟 Judge 程式裝在哪裡無關
 */
export function resolveJudgeHome(cwd = process.cwd(), home = homedir()): JudgeHome {
  const projectConfig = join(cwd, PROJECT_CONFIG_NAME);
  const fromProject = readHome(projectConfig, home);
  if (fromProject !== undefined) return { path: fromProject, source: projectConfig };
  const userConfig = expandPath(USER_CONFIG_PATH, cwd, home);
  const fromUser = readHome(userConfig, home);
  if (fromUser !== undefined) return { path: fromUser, source: userConfig };
  return { path: expandPath(DEFAULT_HOME, cwd, home), source: "預設" };
}

/** 名字只接受小寫英文、數字、連字號（不能以連字號開頭或結尾，不能連續） */
export function validateAgentName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`代理人名稱「${name}」不合法：只能用小寫英文、數字、連字號，例如 my-agent`);
  }
  if (RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留字，不能當代理人名稱`);
}

export function agentPaths(judgeHome: string, name: string): AgentPaths {
  validateAgentName(name);
  const dir = join(judgeHome, "agents", name);
  return {
    name,
    dir,
    identity: join(dir, "IDENTITY.md"),
    memory: join(dir, "MEMORY.md"),
    config: join(dir, "config.json"),
    env: join(dir, ".env"),
    db: join(dir, "judge.db"),
    pid: join(dir, "judge.pid"),
  };
}

/** 現有的代理人名稱（agents/ 下名稱合法的資料夾），依字母排序 */
export function listAgents(judgeHome: string): string[] {
  const agentsDir = join(judgeHome, "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((entry) => NAME_PATTERN.test(entry) && !RESERVED_NAMES.has(entry))
    .filter((entry) => statSync(join(agentsDir, entry)).isDirectory())
    .sort();
}

export type Command = { mode: "start" | "setup"; name: string | undefined };

/**
 * judge <名字>、judge setup <名字>、npm start -- <名字>、npm run setup -- <名字>（setup 腳本會先帶 "setup"）。
 * 「--」是 npm 的寫法，直接打 judge 時多打了也沒關係，一律忽略
 */
export function parseCommand(args: readonly string[]): Command {
  const [first, second] = args.filter((arg) => arg !== "--");
  if (first === "setup") return { mode: "setup", name: second };
  return { mode: "start", name: first };
}

/** 沒指定名字、或名字找不到時的說明，列出現有的代理人 */
export function describeAgents(judgeHome: JudgeHome, mode: Command["mode"]): string {
  const agents = listAgents(judgeHome.path);
  const usage =
    mode === "setup"
      ? ["用法：judge setup <代理人名稱>", "  或在專案目錄：npm run setup -- <代理人名稱>"]
      : ["用法：在要工作的目錄執行 judge <代理人名稱>", "  或在專案目錄：npm start -- <代理人名稱>（工作目錄就是專案）"];
  const lines = [...usage, judgeHomeText(judgeHome)];
  if (agents.length === 0) lines.push("目前還沒有代理人。建立：judge setup <代理人名稱>");
  else lines.push("現有的代理人：", ...agents.map((name) => `  • ${name}`));
  return lines.join("\n");
}

/**
 * 程式內建的預設身分，簡單通用。照 Hermes：第一次寫進 IDENTITY.md（ensureIdentity），
 * IDENTITY.md 不存在或空的時候也拿來當備用（readIdentity）。
 */
export function defaultIdentity(name: string): string {
  return `## 身份\n你是 ${name}，用戶的個人代理人。\n\n## 人格\n\n## 規則\n`;
}

/** IDENTITY.md 不存在或是空的，就寫入預設身分，回傳有沒有寫。有內容的不動 */
export function ensureIdentity(paths: AgentPaths): boolean {
  const content = existsSync(paths.identity) ? readFileSync(paths.identity, "utf8").trim() : undefined;
  if (content !== undefined && content !== "") return false;
  writeFileSync(paths.identity, defaultIdentity(paths.name));
  return true;
}

/** setup 時建立資料夾；IDENTITY.md 寫入預設身分、MEMORY.md 建空檔，已經有內容的不動 */
export function ensureAgentDir(paths: AgentPaths): { seededIdentity: boolean } {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const seededIdentity = ensureIdentity(paths);
  if (!existsSync(paths.memory)) writeFileExclusive(paths.memory, "");
  return { seededIdentity };
}

function writeFileExclusive(path: string, content: string): void {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** 讀 IDENTITY.md；不存在或是空的（例如被清空了）就用預設身分 */
export function readIdentity(paths: AgentPaths): string {
  const content = existsSync(paths.identity) ? readFileSync(paths.identity, "utf8").trim() : "";
  return content === "" ? defaultIdentity(paths.name).trim() : content;
}

/** 讀 MEMORY.md，沒有就當作空的 */
export function readMemory(paths: AgentPaths): string {
  return existsSync(paths.memory) ? readFileSync(paths.memory, "utf8").trim() : "";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：程序存在，只是不屬於我們
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 佔用這個代理人：寫入 judge.pid。已經有別的程式在跑就報錯；
 * 留下來的 pid 檔對應的程式已經不在（例如被強制終止），就直接接手。
 * 回傳釋放的函式（只刪自己寫的 pid 檔）。
 */
export function acquireLock(pidPath: string, pid = process.pid, alive: (pid: number) => boolean = isAlive): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidPath, "wx");
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(pidPath, "utf8").trim() === String(pid)) rmSync(pidPath);
        } catch {
          // 已經不在了就算了
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isInteger(owner) && owner !== pid && alive(owner)) {
        throw new Error(`這個代理人已經在執行（pid ${owner}）。同一個代理人不能同時跑兩個，請先停掉那一個。`);
      }
      rmSync(pidPath, { force: true });
    }
  }
  throw new Error(`無法建立 ${pidPath}`);
}
