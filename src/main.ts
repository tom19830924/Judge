#!/usr/bin/env node
import { existsSync } from "node:fs";
import { COMMANDS, createAgent } from "./agent.ts";
import { findChannel } from "./channels/index.ts";
import { loadEnv, readConfig, resolveMaxSteps, resolveMemoryConfig, resolveSettings, writeConfig, type Config } from "./config.ts";
import { resolveContextWindow } from "./context.ts";
import { acquireLock, agentPaths, describeAgents, ensureIdentity, judgeHomeText, parseCommand, readIdentity, readMemory, resolveJudgeHome } from "./profile.ts";
import { createMemoryTool } from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { findProvider } from "./providers/index.ts";
import { runSetup } from "./setup.ts";
import { openStore } from "./store.ts";
import { createTools } from "./tools.ts";
import type { ModelClient, Settings } from "./types.ts";
import { errorMessage } from "./util.ts";

// judge 資料夾：執行的資料夾的 judge.config.json → ~/.judge/config.json → ~/.judge
let judgeHome;
try {
  judgeHome = resolveJudgeHome();
} catch (error) {
  fail(errorMessage(error));
}
const command = parseCommand(process.argv.slice(2));
if (command.name === undefined) fail(`沒有指定代理人。\n\n${describeAgents(judgeHome, command.mode)}`);

let paths;
try {
  paths = agentPaths(judgeHome.path, command.name);
} catch (error) {
  fail(`${errorMessage(error)}\n\n${describeAgents(judgeHome, command.mode)}`);
}
const setupCommand = `judge setup ${paths.name}`;

// 只讀代理人資料夾的 .env，專案根目錄的 .env 不讀
loadEnv(paths.env);

if (command.mode === "setup") {
  await runSetup(paths);
  process.exit(0);
}

if (!existsSync(paths.dir)) {
  fail(`找不到代理人「${paths.name}」（${paths.dir}）。建立：${setupCommand}\n\n${describeAgents(judgeHome, command.mode)}`);
}

// 同一個代理人不能同時跑兩個：兩個程式寫同一份 DB、收同一個 bot 的訊息會亂
let releaseLock: () => void;
try {
  releaseLock = acquireLock(paths.pid);
} catch (error) {
  fail(errorMessage(error));
}
process.on("exit", () => releaseLock());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));

let config = readConfig(paths.config);
if (!config) {
  console.log("還沒有設定，先進行初始設定。\n");
  await runSetup(paths);
  config = readConfig(paths.config);
}
if (!config) throw new Error("初始設定沒有完成");

// IDENTITY.md 不存在或是空的就寫入預設身分（照 Hermes 的 SOUL.md），之後在對話中修改
if (ensureIdentity(paths)) console.log(`${paths.identity} 是空的，已寫入預設身分`);
const identity = readIdentity(paths);
// 工作目錄就是啟動時的目錄（跟 Claude Code 一樣）。npm start 會先切到專案目錄，要在別處做事就用 judge 指令。
let memoryConfig;
let maxSteps;
try {
  memoryConfig = resolveMemoryConfig(config.memory, paths.config);
  maxSteps = resolveMaxSteps(config.maxSteps, paths.config);
} catch (error) {
  fail(errorMessage(error));
}

const workdir = process.cwd();
if ("workdir" in config) console.warn(`注意：${paths.config} 的 workdir 已經不使用，工作目錄改用啟動時的目錄，可以刪掉這一項`);

const providerDefinition = findProvider(config.provider.id);
const channelDefinition = findChannel(config.channel.id);
const providerSettings = resolveSettings(providerDefinition.fields, config.provider.settings, setupCommand);
const model = providerDefinition.create(providerSettings);
const channel = channelDefinition.create(resolveSettings(channelDefinition.fields, config.channel.settings, setupCommand));
const secretEnvKeys = [...providerDefinition.fields, ...channelDefinition.fields]
  .filter((field) => field.secret)
  .map((field) => field.key);

// 上下文上限可以在設定檔的 provider.settings.contextWindow 指定，沒寫就依模型名稱推斷
const contextWindow = resolveContextWindow(model.model, config.provider.settings["contextWindow"]);

/**
 * /model 換模型：用同一個服務商、同一份設定，只換 model，並寫回 config.json 讓重啟後繼續用。
 * 原本手寫的 contextWindow 是為舊模型設的，一併拿掉，改用新模型推斷出來的
 */
const configPath = paths.config;
let currentConfig: Config = config;
function switchModel(name: string): { client: ModelClient; contextWindow: number } {
  const client = providerDefinition.create({ ...providerSettings, model: name });
  const stored: Settings = { ...currentConfig.provider.settings, model: name };
  delete stored["contextWindow"];
  currentConfig = { ...currentConfig, provider: { id: currentConfig.provider.id, settings: stored } };
  writeConfig(currentConfig, configPath);
  return { client, contextWindow: resolveContextWindow(name, undefined) };
}

const agent = createAgent({
  model,
  channel,
  tools: [...createTools(workdir, secretEnvKeys), createMemoryTool({ path: paths.memory, ...memoryConfig })],
  store: openStore(paths.db),
  // 每次產生都重讀 IDENTITY.md 和 MEMORY.md：改完不用重啟，/reload_prompt 就會用新的
  buildSystemPrompt: () =>
    buildSystemPrompt({
      identity: readIdentity(paths),
      identityPath: paths.identity,
      memory: readMemory(paths),
      workdir,
      channelName: channelDefinition.displayName,
    }),
  contextWindow,
  maxSteps,
  switchModel,
});

channel.setCommands?.(COMMANDS).catch((error: unknown) => console.error("註冊指令選單失敗：", error));

console.log(`Judge 已啟動：${paths.name}（${providerDefinition.displayName} × ${channelDefinition.displayName}）`);
console.log(judgeHomeText(judgeHome));
console.log(`代理人資料夾：${paths.dir}`);
console.log(`工作目錄：${workdir}`);
console.log(`模型：${model.model}，上下文上限 ${contextWindow.toLocaleString()} token`);
console.log(
  `身分 ${identity.length.toLocaleString()} 字，記憶 ${readMemory(paths).length.toLocaleString()} / ${memoryConfig.charLimit.toLocaleString()} 字` +
    `（寫入${memoryConfig.approval ? "要先核准" : "直接寫"}）`,
);
await agent.restoreAll();
await channel.start({
  onMessage: (message) => agent.handleMessage(message),
  onAction: (action) => agent.handleAction(action),
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
