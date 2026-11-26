import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTools, KILL_GRACE_MS, type AskAnswer, type Tool, type ToolContext } from "../src/tools.ts";

function freshWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "bj-tools-"));
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.spec.name === name);
  assert.ok(tool, `找不到工具 ${name}`);
  return tool;
}

test("write_file：建立檔案，會自動建資料夾", async () => {
  const dir = freshWorkdir();
  const tools = createTools(dir, []);
  await toolByName(tools, "write_file").run({ path: "sub/deep/a.txt", content: "內容" });
  assert.equal(readFileSync(join(dir, "sub/deep/a.txt"), "utf8"), "內容");
});

test("read_file：讀相對於工作目錄的檔案", async () => {
  const dir = freshWorkdir();
  writeFileSync(join(dir, "a.txt"), "哈囉");
  const tools = createTools(dir, []);
  assert.equal(await toolByName(tools, "read_file").run({ path: "a.txt" }), "哈囉");
});

test("edit_file：old_text 剛好出現一次時替換", async () => {
  const dir = freshWorkdir();
  writeFileSync(join(dir, "a.txt"), "foo bar baz");
  const tools = createTools(dir, []);
  await toolByName(tools, "edit_file").run({ path: "a.txt", old_text: "bar", new_text: "BAR" });
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "foo BAR baz");
});

test("edit_file：old_text 出現 0 次或多次時報錯、不改檔", async () => {
  const dir = freshWorkdir();
  writeFileSync(join(dir, "a.txt"), "x x x");
  const tools = createTools(dir, []);
  const edit = toolByName(tools, "edit_file");
  await assert.rejects(() => edit.run({ path: "a.txt", old_text: "x", new_text: "y" }), /出現 3 次/);
  await assert.rejects(() => edit.run({ path: "a.txt", old_text: "無", new_text: "y" }), /出現 0 次/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "x x x", "報錯時不應改到檔案");
});

test("edit_file：new_text 含 $& 之類的特殊字也原樣替換", async () => {
  const dir = freshWorkdir();
  writeFileSync(join(dir, "a.txt"), "price: HERE");
  const tools = createTools(dir, []);
  await toolByName(tools, "edit_file").run({ path: "a.txt", old_text: "HERE", new_text: "$100 & up" });
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "price: $100 & up");
});

test("run_command：回傳輸出和結束碼", async () => {
  const tools = createTools(freshWorkdir(), []);
  const output = await toolByName(tools, "run_command").run({ command: "echo hello" });
  assert.ok(output.includes("hello"));
  assert.ok(output.includes("結束碼 0"));
});

test("run_command：非 0 結束碼會呈現出來", async () => {
  const tools = createTools(freshWorkdir(), []);
  const output = await toolByName(tools, "run_command").run({ command: "exit 3" });
  assert.ok(output.includes("結束碼 3"));
});

test("run_command：在工作目錄執行", async () => {
  const dir = freshWorkdir();
  writeFileSync(join(dir, "marker.txt"), "");
  const tools = createTools(dir, []);
  const output = await toolByName(tools, "run_command").run({ command: "ls" });
  assert.ok(output.includes("marker.txt"));
});

test("run_command：機密環境變數不會傳給子程序", async () => {
  process.env["MY_SECRET"] = "leak-me";
  try {
    const tools = createTools(freshWorkdir(), ["MY_SECRET"]);
    const output = await toolByName(tools, "run_command").run({ command: "echo [$MY_SECRET]" });
    assert.ok(!output.includes("leak-me"), "機密不應出現在子程序環境");
    assert.ok(output.includes("[]"));
  } finally {
    delete process.env["MY_SECRET"];
  }
});

test("run_command：逾時會終止並標示", async () => {
  const tools = createTools(freshWorkdir(), []);
  const output = await toolByName(tools, "run_command").run({ command: "sleep 5", timeout_seconds: 1 });
  assert.ok(output.includes("逾時"));
});

test("run_command：中止時先 SIGTERM，保留已輸出的內容", async () => {
  const tools = createTools(freshWorkdir(), []);
  const controller = new AbortController();
  const started = Date.now();
  const pending = toolByName(tools, "run_command").run({ command: "echo 開始; sleep 30" }, controller.signal);
  await delay(300);
  controller.abort();
  const output = await pending;
  assert.ok(output.includes("開始"), "中止前的輸出要保留");
  assert.ok(output.includes("已被用戶中止"));
  assert.ok(Date.now() - started < KILL_GRACE_MS, "SIGTERM 就能停的不用等到 SIGKILL");
});

test("run_command：不理 SIGTERM 的程式，寬限後用 SIGKILL 強制終止，子程序一起停", async () => {
  const tools = createTools(freshWorkdir(), []);
  const controller = new AbortController();
  const pending = toolByName(tools, "run_command").run(
    { command: "trap '' TERM; sleep 30 & sleep 30; wait" },
    controller.signal,
  );
  await delay(300);
  const started = Date.now();
  controller.abort();
  const output = await pending;
  assert.ok(output.includes("已被用戶中止"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= KILL_GRACE_MS - 100 && elapsed < KILL_GRACE_MS + 2000, `應在寬限後結束，實際 ${elapsed}ms`);
});

test("工具參數型別錯誤時報錯", async () => {
  const tools = createTools(freshWorkdir(), []);
  await assert.rejects(() => toolByName(tools, "read_file").run({ path: 123 }), /必須是字串/);
});

// ── ask_user ──

function askContext(answer: AskAnswer) {
  const asked: { question: string; options: string[] }[] = [];
  const context: ToolContext = {
    chatId: "c1",
    requestApproval: async () => ({ cancelled: "測試不支援" }),
    askUser: async (question, options) => {
      asked.push({ question, options });
      return answer;
    },
  };
  return { context, asked };
}

test("ask_user：把問題和選項交給 context，回傳用戶選的那個", async () => {
  const tools = createTools(freshWorkdir(), []);
  const { context, asked } = askContext({ chosen: "乙" });
  const result = await toolByName(tools, "ask_user").run({ question: "選哪個？", options: ["甲", "乙"] }, undefined, context);
  assert.deepEqual(asked, [{ question: "選哪個？", options: ["甲", "乙"] }]);
  assert.equal(result, "用戶選了：乙");
});

test("ask_user：用戶沒選時說明原因，不當成錯誤", async () => {
  const tools = createTools(freshWorkdir(), []);
  const { context } = askContext({ cancelled: "用戶傳了新訊息" });
  const result = await toolByName(tools, "ask_user").run({ question: "選哪個？", options: ["甲"] }, undefined, context);
  assert.equal(result, "用戶沒有選（用戶傳了新訊息）");
});

test("ask_user：選項不是字串陣列、空陣列時報錯", async () => {
  const tools = createTools(freshWorkdir(), []);
  const { context } = askContext({ chosen: "甲" });
  const ask = toolByName(tools, "ask_user");
  await assert.rejects(() => ask.run({ question: "？", options: "甲" }, undefined, context), /字串陣列/);
  await assert.rejects(() => ask.run({ question: "？", options: [1, 2] }, undefined, context), /字串陣列/);
  await assert.rejects(() => ask.run({ question: "？", options: [] }, undefined, context), /不能是空的/);
});

test("ask_user：沒有 context（不支援問用戶）時報錯", async () => {
  const tools = createTools(freshWorkdir(), []);
  await assert.rejects(() => toolByName(tools, "ask_user").run({ question: "？", options: ["甲"] }), /不支援問用戶/);
});
