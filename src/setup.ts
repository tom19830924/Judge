import type { Interface } from "node:readline/promises";
import { createInterface } from "node:readline/promises";
import { channels } from "./channels/index.ts";
import { readConfigDraft, updateEnvFile, writeConfig, type Selection } from "./config.ts";
import { ensureAgentDir, type AgentPaths } from "./profile.ts";
import { providers } from "./providers/index.ts";
import type { Settings, SetupField } from "./types.ts";

type Option = { id: string; displayName: string; fields: SetupField[] };

/** 互動式初始設定：選服務商和通訊軟體，再逐一填它們需要的欄位 */
export async function runSetup(paths: AgentPaths): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Judge 初始設定：${paths.name}（直接按 Enter 使用 [ ] 裡的值）`);
    console.log(`代理人資料夾：${paths.dir}（judge 資料夾的位置看執行的資料夾有沒有 judge.config.json，沒有就用 ~/.judge）\n`);
    const { seededIdentity } = ensureAgentDir(paths);
    const previous = readConfigDraft(paths.config);
    const secrets: Record<string, string> = {};

    const provider = await configure(rl, "模型服務商", providers, previous?.provider, secrets);
    const channel = await configure(rl, "通訊軟體", channels, previous?.channel, secrets);

    // 手動加的 memory、maxSteps 設定保留
    writeConfig(
      {
        provider,
        channel,
        ...(previous?.memory ? { memory: previous.memory } : {}),
        ...(previous?.maxSteps !== undefined ? { maxSteps: previous.maxSteps } : {}),
      },
      paths.config,
    );
    if (Object.keys(secrets).length > 0) updateEnvFile(secrets, paths.env);
    Object.assign(process.env, secrets);

    console.log(`設定已寫入 ${paths.config}`);
    if (Object.keys(secrets).length > 0) console.log(`機密已寫入 ${paths.env}`);
    if (seededIdentity) console.log(`已在 ${paths.identity} 寫入預設身分，之後可以在對話中請它修改`);
    console.log("");
  } finally {
    rl.close();
  }
}

async function configure(
  rl: Interface,
  title: string,
  options: readonly Option[],
  previous: Selection | undefined,
  secrets: Record<string, string>,
): Promise<Selection> {
  const option = await choose(rl, title, options, previous?.id);
  const stored = previous?.id === option.id ? previous.settings : {};
  const settings: Settings = {};

  for (const field of option.fields) {
    const current = field.secret ? process.env[field.key] : (stored[field.key] ?? field.default);
    const shown = current === undefined || current === "" ? "" : field.secret ? " [已設定，Enter 保留]" : ` [${current}]`;
    if (field.hint) console.log(`  （${field.hint}）`);

    for (;;) {
      const answer = (await rl.question(`${field.label}${shown}：`)).trim();
      const value = answer === "" ? current : answer;
      if (value === undefined || value === "") {
        console.log("  此欄位必填");
        continue;
      }
      if (!field.secret) settings[field.key] = value;
      else if (answer !== "") secrets[field.key] = value;
      break;
    }
  }
  // 設定檔裡手動加的其他欄位（例如 contextWindow）保留
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in settings) && !option.fields.some((field) => field.key === key)) settings[key] = value;
  }
  console.log("");
  return { id: option.id, settings };
}

async function choose<T extends Option>(rl: Interface, title: string, options: readonly T[], currentId?: string): Promise<T> {
  console.log(`選擇${title}：`);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option.displayName}`));
  const defaultIndex = Math.max(0, options.findIndex((option) => option.id === currentId));

  for (;;) {
    const answer = (await rl.question(`請輸入編號 [${defaultIndex + 1}]：`)).trim();
    const option = options[answer === "" ? defaultIndex : Number(answer) - 1];
    if (option) return option;
    console.log("  編號不正確，請重新輸入");
  }
}
