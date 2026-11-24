import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig, readConfigDraft, resolveMemoryConfig, resolveSettings, requireSetting, updateEnvFile, writeConfig } from "../src/config.ts";
import type { SetupField } from "../src/types.ts";

function tempEnv(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "bj-env-")), ".env");
  writeFileSync(path, content);
  return path;
}

test("updateEnvFile：只改指定的變數，其他行原樣保留", () => {
  const path = tempEnv("A=1\nB=2\n# 註解\nC=3\n");
  updateEnvFile({ B: "999" }, path);
  assert.equal(readFileSync(path, "utf8"), "A=1\nB=999\n# 註解\nC=3\n");
});

test("updateEnvFile：沒有的變數會補在最後", () => {
  const path = tempEnv("A=1\n");
  updateEnvFile({ NEW: "x" }, path);
  assert.equal(readFileSync(path, "utf8"), "A=1\nNEW=x\n");
});

test("updateEnvFile：檔案不存在時直接建立", () => {
  const path = join(mkdtempSync(join(tmpdir(), "bj-env-")), ".env");
  updateEnvFile({ A: "1" }, path);
  assert.equal(readFileSync(path, "utf8"), "A=1\n");
});

const tempConfigPath = () => join(mkdtempSync(join(tmpdir(), "bj-config-")), "config.json");
const selection = { id: "x", settings: {} };

test("readConfig：沒有檔案回傳 undefined；writeConfig 寫的讀得回來", () => {
  const path = tempConfigPath();
  assert.equal(readConfig(path), undefined);
  const config = { provider: selection, channel: selection };
  writeConfig(config, path);
  assert.deepEqual(readConfig(path), config);
});

test("readConfig：缺 provider 或 channel 就報錯；readConfigDraft 不檢查", () => {
  const path = tempConfigPath();
  writeFileSync(path, JSON.stringify({ channel: selection }));
  assert.throws(() => readConfig(path), /缺少 provider 或 channel/);
  assert.deepEqual(readConfigDraft(path), { channel: selection });
});

test("readConfig：舊版留下的 workdir 不影響讀取", () => {
  const path = tempConfigPath();
  writeFileSync(path, JSON.stringify({ provider: selection, channel: selection, workdir: "/w" }));
  assert.equal(readConfig(path)?.provider.id, "x");
});

test("resolveSettings：機密從環境變數拿，其他從設定檔拿", () => {
  const fields: SetupField[] = [
    { key: "SECRET_KEY", label: "金鑰", secret: true },
    { key: "baseUrl", label: "網址", secret: false, default: "https://example.com" },
  ];
  process.env["SECRET_KEY"] = "s3cr3t";
  try {
    const settings = resolveSettings(fields, { baseUrl: "https://custom.com" });
    assert.equal(settings["SECRET_KEY"], "s3cr3t");
    assert.equal(settings["baseUrl"], "https://custom.com");
  } finally {
    delete process.env["SECRET_KEY"];
  }
});

test("resolveSettings：非機密欄位沒值時用 default", () => {
  const fields: SetupField[] = [{ key: "model", label: "模型", secret: false, default: "claude-opus-5-5" }];
  assert.equal(resolveSettings(fields, {})["model"], "claude-opus-5-5");
});

test("resolveSettings：缺任何一項就報錯，並列出缺的欄位名稱", () => {
  const fields: SetupField[] = [{ key: "TOKEN", label: "權杖", secret: true }];
  delete process.env["TOKEN"];
  assert.throws(() => resolveSettings(fields, {}), /缺少設定：權杖。請執行 npm run setup/);
  assert.throws(() => resolveSettings(fields, {}, "npm run setup -- a"), /請執行 npm run setup -- a/);
});

test("requireSetting：有值回傳，沒值報錯", () => {
  assert.equal(requireSetting({ a: "1" }, "a"), "1");
  assert.throws(() => requireSetting({}, "a"), /缺少設定：a/);
});

test("resolveMemoryConfig：沒寫用預設值（直接寫、2200 字），只寫一項另一項用預設", () => {
  assert.deepEqual(resolveMemoryConfig(undefined), { approval: false, charLimit: 2200 });
  assert.deepEqual(resolveMemoryConfig({}), { approval: false, charLimit: 2200 });
  assert.deepEqual(resolveMemoryConfig({ approval: true }), { approval: true, charLimit: 2200 });
  assert.deepEqual(resolveMemoryConfig({ charLimit: 3000 }), { approval: false, charLimit: 3000 });
});

test("resolveMemoryConfig：型別不對就報錯，不默默用預設值", () => {
  assert.throws(() => resolveMemoryConfig("on"), /memory 必須是物件/);
  assert.throws(() => resolveMemoryConfig({ approval: "true" }), /memory.approval 必須是 true 或 false/);
  assert.throws(() => resolveMemoryConfig({ charLimit: "2200" }), /memory.charLimit 必須是正整數/);
  assert.throws(() => resolveMemoryConfig({ charLimit: 0 }), /memory.charLimit 必須是正整數/);
  assert.throws(() => resolveMemoryConfig({ charLimit: 1.5 }), /memory.charLimit 必須是正整數/);
});
