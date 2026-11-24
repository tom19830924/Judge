import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireLock,
  agentPaths,
  defaultIdentity,
  describeAgents,
  ensureAgentDir,
  ensureIdentity,
  judgeHomeText,
  expandPath,
  listAgents,
  parseCommand,
  readIdentity,
  readMemory,
  resolveJudgeHome,
  validateAgentName,
} from "../src/profile.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "judge-profile-"));

test("expandPath：~ 換成家目錄，相對路徑以 base 為起點，絕對路徑不動", () => {
  assert.equal(expandPath("~", "/base", "/home/u"), "/home/u");
  assert.equal(expandPath("~/.judge", "/base", "/home/u"), "/home/u/.judge");
  assert.equal(expandPath("data/x", "/base", "/home/u"), "/base/data/x");
  assert.equal(expandPath("/abs/path", "/base", "/home/u"), "/abs/path");
});

/** 假的家目錄和執行的資料夾，互不包含 */
function layout() {
  const root = tempDir();
  const home = join(root, "home");
  const cwd = join(root, "work", "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const userConfig = join(home, ".judge", "config.json");
  const projectConfig = join(cwd, "judge.config.json");
  const writeUser = (content: unknown) => {
    mkdirSync(join(home, ".judge"), { recursive: true });
    writeFileSync(userConfig, JSON.stringify(content));
  };
  return { root, home, cwd, userConfig, projectConfig, writeUser };
}

test("resolveJudgeHome：兩層都沒有設定檔，用預設的 ~/.judge", () => {
  const { home, cwd } = layout();
  assert.deepEqual(resolveJudgeHome(cwd, home), { path: join(home, ".judge"), source: "預設" });
});

test("resolveJudgeHome：執行的資料夾有 judge.config.json 就用它，相對路徑從那個資料夾算", () => {
  const { home, cwd, projectConfig, writeUser } = layout();
  writeUser({ home: "~/user-judge" });
  writeFileSync(projectConfig, JSON.stringify({ home: ".judge" }));
  assert.deepEqual(resolveJudgeHome(cwd, home), { path: join(cwd, ".judge"), source: projectConfig }, "專案層優先");
  writeFileSync(projectConfig, JSON.stringify({ home: "~/elsewhere" }));
  assert.equal(resolveJudgeHome(cwd, home).path, join(home, "elsewhere"));
});

test("resolveJudgeHome：執行的資料夾沒有設定檔，用 ~/.judge/config.json；相對路徑從 ~/.judge 算", () => {
  const { home, cwd, userConfig, writeUser } = layout();
  writeUser({ home: "~/user-judge" });
  assert.deepEqual(resolveJudgeHome(cwd, home), { path: join(home, "user-judge"), source: userConfig });
  writeUser({ home: "data" });
  assert.equal(resolveJudgeHome(cwd, home).path, join(home, ".judge", "data"));
});

test("resolveJudgeHome：設定檔沒寫 home 就往下一層找", () => {
  const { home, cwd, projectConfig, userConfig, writeUser } = layout();
  writeFileSync(projectConfig, JSON.stringify({}));
  writeUser({ home: "~/user-judge" });
  assert.deepEqual(resolveJudgeHome(cwd, home), { path: join(home, "user-judge"), source: userConfig });
  writeUser({});
  assert.deepEqual(resolveJudgeHome(cwd, home), { path: join(home, ".judge"), source: "預設" });
});

test("resolveJudgeHome：只看執行的那個資料夾，不往上層找", () => {
  const { home, cwd } = layout();
  writeFileSync(join(cwd, "..", "judge.config.json"), JSON.stringify({ home: "/parent-judge" }));
  assert.equal(resolveJudgeHome(cwd, home).path, join(home, ".judge"));
});

test("resolveJudgeHome：home 不是非空字串就報錯，說是哪個設定檔", () => {
  const { home, cwd, projectConfig } = layout();
  writeFileSync(projectConfig, JSON.stringify({ home: "" }));
  assert.throws(() => resolveJudgeHome(cwd, home), new RegExp(`${projectConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 的 home 必須是非空字串`));
  writeFileSync(projectConfig, JSON.stringify({ home: 1 }));
  assert.throws(() => resolveJudgeHome(cwd, home), /home 必須是非空字串/);
});

test("judgeHomeText：寫出 judge 資料夾和來源", () => {
  assert.equal(judgeHomeText({ path: "/h/.judge", source: "預設" }), "judge 資料夾：/h/.judge（預設）");
  assert.equal(judgeHomeText({ path: "/p/.judge", source: "/p/judge.config.json" }), "judge 資料夾：/p/.judge（來自 /p/judge.config.json）");
});

test("validateAgentName：只接受小寫英文、數字、連字號", () => {
  for (const name of ["my-agent", "a", "agent2", "a-b-c"]) assert.doesNotThrow(() => validateAgentName(name));
  for (const name of ["MyAgent", "my_agent", "-a", "a-", "a--b", "", "../x", "a b", "中文"]) {
    assert.throws(() => validateAgentName(name), /不合法/, name);
  }
  assert.throws(() => validateAgentName("setup"), /保留字/);
});

test("agentPaths：檔案都在 agents/<名字>/ 下；名字不合法就報錯", () => {
  const paths = agentPaths("/j", "my-agent");
  assert.equal(paths.dir, "/j/agents/my-agent");
  assert.equal(paths.identity, "/j/agents/my-agent/IDENTITY.md");
  assert.equal(paths.memory, "/j/agents/my-agent/MEMORY.md");
  assert.equal(paths.config, "/j/agents/my-agent/config.json");
  assert.equal(paths.env, "/j/agents/my-agent/.env");
  assert.equal(paths.db, "/j/agents/my-agent/judge.db");
  assert.throws(() => agentPaths("/j", "../etc"), /不合法/);
});

test("listAgents：只列名稱合法的資料夾，依字母排序；沒有 agents/ 回傳空陣列", () => {
  const home = tempDir();
  assert.deepEqual(listAgents(home), []);
  for (const name of ["zeta", "my-agent", "Bad_Name"]) mkdirSync(join(home, "agents", name), { recursive: true });
  writeFileSync(join(home, "agents", "file-not-dir"), "");
  assert.deepEqual(listAgents(home), ["my-agent", "zeta"]);
});

test("parseCommand：第一個參數是 setup 就是設定模式，名字在後面", () => {
  assert.deepEqual(parseCommand([]), { mode: "start", name: undefined });
  assert.deepEqual(parseCommand(["my-agent"]), { mode: "start", name: "my-agent" });
  assert.deepEqual(parseCommand(["setup"]), { mode: "setup", name: undefined });
  assert.deepEqual(parseCommand(["setup", "my-agent"]), { mode: "setup", name: "my-agent" });
});

test("parseCommand：照 npm 的習慣多打了 --，一律忽略", () => {
  assert.deepEqual(parseCommand(["--", "judge-dev"]), { mode: "start", name: "judge-dev" });
  assert.deepEqual(parseCommand(["setup", "--", "judge-dev"]), { mode: "setup", name: "judge-dev" });
  assert.deepEqual(parseCommand(["--", "setup", "judge-dev"]), { mode: "setup", name: "judge-dev" });
  assert.deepEqual(parseCommand(["--"]), { mode: "start", name: undefined });
});

test("describeAgents：列出現有的代理人；沒有就提示怎麼建立", () => {
  const home = { path: tempDir(), source: "預設" };
  assert.match(describeAgents(home, "start"), /目前還沒有代理人。建立：judge setup <代理人名稱>/);
  mkdirSync(join(home.path, "agents", "my-agent"), { recursive: true });
  const text = describeAgents(home, "start");
  assert.match(text, /judge 資料夾：.*（預設）/);
  assert.match(text, /用法：在要工作的目錄執行 judge <代理人名稱>/);
  assert.match(text, /npm start -- <代理人名稱>（工作目錄就是專案）/);
  assert.match(text, /• my-agent/);
  assert.match(describeAgents(home, "setup"), /用法：judge setup <代理人名稱>/);
});

const DEFAULT_A = "## 身份\n你是 a，用戶的個人代理人。\n\n## 人格\n\n## 規則\n";

test("defaultIdentity：分成身份、人格、規則三段，身份帶入代理人名稱，其他兩段空著", () => {
  assert.equal(defaultIdentity("a"), DEFAULT_A);
});

test("ensureAgentDir：建立資料夾，IDENTITY.md 寫入預設身分，MEMORY.md 建空檔；已經有內容的不覆寫", () => {
  const paths = agentPaths(tempDir(), "a");
  assert.deepEqual(ensureAgentDir(paths), { seededIdentity: true });
  assert.equal(readFileSync(paths.identity, "utf8"), DEFAULT_A);
  assert.equal(readFileSync(paths.memory, "utf8"), "");

  writeFileSync(paths.identity, "我是 a");
  writeFileSync(paths.memory, "記得 x");
  assert.deepEqual(ensureAgentDir(paths), { seededIdentity: false });
  assert.equal(readFileSync(paths.identity, "utf8"), "我是 a");
  assert.equal(readFileSync(paths.memory, "utf8"), "記得 x");
});

test("ensureIdentity：不存在或只有空白就寫入預設身分；有內容的不動", () => {
  const paths = agentPaths(tempDir(), "a");
  mkdirSync(paths.dir, { recursive: true });
  assert.equal(ensureIdentity(paths), true, "不存在");
  assert.equal(readFileSync(paths.identity, "utf8"), DEFAULT_A);

  writeFileSync(paths.identity, " \n");
  assert.equal(ensureIdentity(paths), true, "空白");
  assert.equal(readFileSync(paths.identity, "utf8"), DEFAULT_A);

  writeFileSync(paths.identity, "自訂的身分");
  assert.equal(ensureIdentity(paths), false);
  assert.equal(readFileSync(paths.identity, "utf8"), "自訂的身分");
});

test("readIdentity：有內容就用（去掉頭尾空白）；不存在或空白就用預設身分", () => {
  const paths = agentPaths(tempDir(), "a");
  assert.equal(readIdentity(paths), DEFAULT_A.trim());
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.identity, "  \n");
  assert.equal(readIdentity(paths), DEFAULT_A.trim());
  writeFileSync(paths.identity, "\n我是 a\n");
  assert.equal(readIdentity(paths), "我是 a");
});

test("readMemory：沒有檔案當作空的", () => {
  const paths = agentPaths(tempDir(), "a");
  assert.equal(readMemory(paths), "");
  ensureAgentDir(paths);
  writeFileSync(paths.memory, "記得 x\n");
  assert.equal(readMemory(paths), "記得 x");
});

test("acquireLock：寫入 pid，釋放後刪掉", () => {
  const pidPath = join(tempDir(), "judge.pid");
  const release = acquireLock(pidPath, 111, () => false);
  assert.equal(readFileSync(pidPath, "utf8"), "111\n");
  release();
  assert.equal(existsSync(pidPath), false);
});

test("acquireLock：別的程式還在跑就報錯，pid 檔不動", () => {
  const pidPath = join(tempDir(), "judge.pid");
  writeFileSync(pidPath, "222\n");
  assert.throws(() => acquireLock(pidPath, 111, (pid) => pid === 222), /已經在執行（pid 222）/);
  assert.equal(readFileSync(pidPath, "utf8"), "222\n");
});

test("acquireLock：留下來的 pid 檔對應的程式已經不在，就接手", () => {
  const pidPath = join(tempDir(), "judge.pid");
  writeFileSync(pidPath, "222\n");
  acquireLock(pidPath, 111, () => false);
  assert.equal(readFileSync(pidPath, "utf8"), "111\n");
});

test("acquireLock：pid 檔內容壞掉也接手", () => {
  const pidPath = join(tempDir(), "judge.pid");
  writeFileSync(pidPath, "garbage");
  acquireLock(pidPath, 111, () => true);
  assert.equal(readFileSync(pidPath, "utf8"), "111\n");
});

test("acquireLock：釋放時只刪自己的 pid 檔", () => {
  const pidPath = join(tempDir(), "judge.pid");
  const release = acquireLock(pidPath, 111, () => false);
  writeFileSync(pidPath, "333\n");
  release();
  assert.equal(readFileSync(pidPath, "utf8"), "333\n");
});

test("acquireLock：用真的 process.kill 判斷，自己的 pid 當作還在跑", () => {
  const pidPath = join(tempDir(), "judge.pid");
  writeFileSync(pidPath, `${process.pid}\n`);
  assert.throws(() => acquireLock(pidPath, process.pid + 100000), /已經在執行/);
});
