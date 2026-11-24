import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createAgent, heartbeatText, mergeTools, STOPPED_NOTE, usageText } from "../src/agent.ts";
import { openStore } from "../src/store.ts";
import type { Block, Button, Channel, ChannelHandlers, ModelClient, ModelRequest, ModelResponse } from "../src/types.ts";
import type { ApprovalAnswer, Tool } from "../src/tools.ts";

// ── 假的 model：依腳本回應，並記下每次收到的請求  ──
type Responder = (callIndex: number) => ModelResponse;
function fakeModel(responder: Responder) {
  const requests: ModelRequest[] = [];
  const model: ModelClient & { requests: ModelRequest[] } = {
    model: "test-model",
    requests,
    async complete(request) {
      // 快照：agent 傳的是 history 原陣列，之後會被 append 改掉，要存當下的樣子
      requests.push({ ...request, messages: structuredClone(request.messages) });
      return responder(requests.length - 1);
    },
  };
  return model;
}

const rText = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end", rawStopReason: "end_turn", usage: null });
const rTool = (id: string, name: string, input: Record<string, unknown>): ModelResponse => ({ content: [{ type: "tool_call", id, name, input }], stopReason: "tool_use", rawStopReason: "tool_use", usage: null });
const rEmpty = (raw: string | null): ModelResponse => ({ content: [], stopReason: "other", rawStopReason: raw, usage: null });

// ── 假的 channel：記下所有輸出  ──
class FakeChannel implements Channel {
  sends: string[] = [];
  buttons: { text: string; rows: Button[][] }[] = [];
  edits: { messageId: string; text: string }[] = [];
  /** 依序記下 typing 和 send，用來確認「輸入中」在回覆之前送出 */
  events: string[] = [];
  async typing(chatId: string): Promise<void> {
    this.events.push(`typing:${chatId}`);
  }
  start(_handlers: ChannelHandlers): Promise<never> {
    return new Promise<never>(() => {});
  }
  async send(_chatId: string, text: string): Promise<void> {
    this.sends.push(text);
    this.events.push(`send:${text}`);
  }
  async sendButtons(_chatId: string, text: string, rows: Button[][]): Promise<string> {
    this.buttons.push({ text, rows });
    return `btn${this.buttons.length}`;
  }
  async editMessage(_chatId: string, messageId: string, text: string): Promise<void> {
    this.edits.push({ messageId, text });
  }
  statuses: string[] = [];
  async sendSilent(_chatId: string, text: string): Promise<void> {
    this.statuses.push(text);
  }
}

const echoTool: Tool = {
  spec: { name: "echo", description: "回傳收到的參數", inputSchema: { type: "object", properties: {} } },
  run: async (input) => `echoed:${JSON.stringify(input)}`,
};

function setup(responder: Responder, maxSteps = 30) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"));
  const channel = new FakeChannel();
  const model = fakeModel(responder);
  const agent = createAgent({
    model,
    channel,
    tools: [echoTool],
    store,
    buildSystemPrompt: () => "你是測試用的 agent。",
    contextWindow: 200_000,
    maxSteps,
  });
  return { agent, channel, model, store };
}

/** 慢速的假 model：每次呼叫都等測試 release 才回應，用來模擬「推論中」又收到訊息 */
function slowModel() {
  const requests: ModelRequest[] = [];
  const aborted: boolean[] = [];
  const pending: ((response: ModelResponse) => void)[] = [];
  const model: ModelClient & { requests: ModelRequest[]; aborted: boolean[] } = {
    model: "test-model",
    requests,
    aborted,
    complete(request) {
      const index = requests.length;
      requests.push({ ...request, signal: undefined, messages: structuredClone(request.messages) });
      aborted.push(false);
      return new Promise<ModelResponse>((resolve, reject) => {
        pending[index] = resolve;
        request.signal?.addEventListener("abort", () => {
          aborted[index] = true;
          reject(new Error("aborted"));
        });
      });
    },
  };
  /** 回應最新一次呼叫 */
  const release = (response: string | ModelResponse) =>
    pending[requests.length - 1]?.(typeof response === "string" ? rText(response) : response);
  return { model, release };
}

function setupSlow(tools: Tool[] = [echoTool], heartbeatMs?: number) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"));
  const channel = new FakeChannel();
  const { model, release } = slowModel();
  const agent = createAgent({ model, channel, tools, store, buildSystemPrompt: () => "測試", contextWindow: 200_000, maxSteps: 30, heartbeatMs });
  return { agent, channel, model, release, store };
}

const msg = (chatId: string, text: string) => ({ chatId, userId: "u1", text });

/** 佇列是非同步的，輪詢等到輸出數量到達，或逾時 */
async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("等待逾時");
    await delay(5);
  }
}

test("一般對話：把模型的文字回覆傳回去，並存進資料庫", async () => {
  const { agent, channel, store } = setup(() => rText("哈囉"));
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);

  assert.deepEqual(channel.sends, ["哈囉"]);
  const sessions = store.listSessions("c1", 10);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.messageCount, 2, "存了 user + assistant 兩則");
});

test("處理訊息期間顯示輸入中：回覆之前先送 typing", async () => {
  const { agent, channel } = setup(() => rText("哈囉"));
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);

  assert.deepEqual(channel.events, ["typing:c1", "send:哈囉"]);
});

test("typing 失敗不影響回覆", async () => {
  const { agent, channel } = setup(() => rText("照樣回"));
  channel.typing = async () => {
    throw new Error("網路斷了");
  };
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);

  assert.deepEqual(channel.sends, ["照樣回"]);
});

test("推論中又傳訊息：中止推論，兩則合併重新推論，只回一次", async () => {
  const { agent, channel, model, release } = setupSlow();
  agent.handleMessage(msg("c1", "你是誰"));
  await waitFor(() => model.requests.length >= 1);

  agent.handleMessage(msg("c1", "你能做些什麼"));
  await waitFor(() => model.requests.length >= 2);
  assert.ok(model.aborted[0], "第一次推論要被中止");

  release("我是 Judge，可以幫你…");
  await waitFor(() => channel.sends.length >= 1);
  await delay(20);
  assert.deepEqual(channel.sends, ["我是 Judge，可以幫你…"], "只回一次");

  const last = model.requests[1]?.messages.at(-1);
  assert.equal(last?.role, "user");
  assert.deepEqual(
    last?.content.map((block) => (block.type === "text" ? block.text : block.type)),
    ["你是誰", "你能做些什麼"],
    "兩則併在同一個用戶回合",
  );
});

test("推論中連傳多則：全部併成一次推論", async () => {
  const { agent, channel, model, release } = setupSlow();
  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => model.requests.length >= 1);
  agent.handleMessage(msg("c1", "二"));
  agent.handleMessage(msg("c1", "三"));
  await waitFor(() => model.requests.length >= 2);

  release("好");
  await waitFor(() => channel.sends.length >= 1);
  await delay(20);
  assert.equal(model.requests.length, 2, "二、三併成一批，只重新推論一次");
  assert.deepEqual(channel.sends, ["好"]);
  const texts = model.requests[1]?.messages.at(-1)?.content.map((block) => (block.type === "text" ? block.text : ""));
  assert.deepEqual(texts, ["一", "二", "三"]);
});

test("工具執行中傳訊息：不砍工具，工具做完後直接併進下一次推論", async () => {
  let toolRuns = 0;
  const slowTool: Tool = {
    spec: { name: "slow", description: "", inputSchema: { type: "object", properties: {} } },
    run: async () => {
      toolRuns++;
      await delay(50);
      return "工具做完了";
    },
  };
  const { agent, channel, model, release } = setupSlow([slowTool]);
  agent.handleMessage(msg("c1", "跑工具"));
  await waitFor(() => model.requests.length >= 1);
  release(rTool("t1", "slow", {}));
  // 工具開始跑之後才傳新訊息
  await waitFor(() => toolRuns >= 1);
  agent.handleMessage(msg("c1", "順便補充"));

  await waitFor(() => model.requests.length >= 2);
  release("完成，也看到補充了");
  await waitFor(() => channel.sends.length >= 1);
  await delay(20);

  assert.equal(toolRuns, 1, "工具只跑一次，沒被中斷重跑");
  assert.equal(model.requests.length, 2, "補充的訊息併進工具後的那次推論，不另開一輪");
  assert.deepEqual(channel.sends, ["完成，也看到補充了"]);
  const lastRequest = model.requests.at(-1);
  const blocks: Block[] = lastRequest?.messages.flatMap((message): Block[] => message.content) ?? [];
  assert.ok(blocks.some((block) => block.type === "tool_result"), "工具結果還在上下文");
  assert.ok(blocks.some((block) => block.type === "text" && block.text === "順便補充"), "補充的訊息也在");
});

test("指令不會中止推論，也不會被併進文字訊息", async () => {
  const { agent, channel, model, release } = setupSlow();
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => model.requests.length >= 1);
  agent.handleMessage(msg("c1", "/help"));
  await delay(20);
  assert.equal(model.aborted[0], false, "指令不中止推論");

  release("嗨");
  await waitFor(() => channel.sends.length >= 2);
  assert.equal(channel.sends[0], "嗨");
  assert.ok(channel.sends[1]?.includes("可用的指令"));
});

test("/stop：推論中停止，回覆已停止，不再呼叫模型；下一則正常處理", async () => {
  const { agent, channel, model, release, store } = setupSlow();
  agent.handleMessage(msg("c1", "寫一篇長文"));
  await waitFor(() => model.requests.length >= 1);

  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(model.aborted[0], "推論被中止");
  assert.ok(channel.sends[0]?.includes("已停止"));
  await delay(20);
  assert.equal(model.requests.length, 1, "停止後不再呼叫模型");

  agent.handleMessage(msg("c1", "換個問題"));
  await waitFor(() => model.requests.length >= 2);
  const messages = model.requests[1]?.messages ?? [];
  assert.deepEqual(messages.map((message) => message.role), ["user"], "備註放在用戶這側，跟下一則併成同一個用戶回合");
  const texts = messages[0]?.content.map((block) => (block.type === "text" ? block.text : ""));
  assert.deepEqual(texts, ["寫一篇長文", STOPPED_NOTE, "換個問題"]);
  assert.ok(!messages.some((message) => message.role === "assistant"), "不放進助理的台詞，模型才不會照著說");
  release("好");
  await waitFor(() => channel.sends.length >= 2);
  assert.equal(channel.sends[1], "好");
  assert.equal(store.listSessions("c1", 10)[0]?.messageCount, 4);
});

test("/stop：中止正在跑的工具，工具結果標示被中止", async () => {
  let toolSignal: AbortSignal | undefined;
  const longTool: Tool = {
    spec: { name: "long", description: "", inputSchema: { type: "object", properties: {} } },
    run: (_input, signal) =>
      new Promise((resolve) => {
        toolSignal = signal;
        signal?.addEventListener("abort", () => resolve("跑到一半\n[已被用戶中止]"));
      }),
  };
  const { agent, channel, model, release } = setupSlow([longTool]);
  agent.handleMessage(msg("c1", "編譯"));
  await waitFor(() => model.requests.length >= 1);
  release({ ...rTool("t1", "long", {}), content: [{ type: "tool_call", id: "t1", name: "long", input: {} }, { type: "tool_call", id: "t2", name: "long", input: {} }] });
  await waitFor(() => toolSignal !== undefined);

  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("已停止"));

  agent.handleMessage(msg("c1", "下一題"));
  await waitFor(() => model.requests.length >= 2);
  const messages = model.requests[1]?.messages ?? [];
  const results = messages.flatMap((message): Block[] => message.content).filter((block) => block.type === "tool_result");
  assert.equal(results.length, 2, "兩個工具呼叫都有結果");
  assert.ok(results[0]?.type === "tool_result" && results[0].content.includes("已被用戶中止"));
  assert.ok(results[1]?.type === "tool_result" && results[1].content.includes("未執行"), "第二個沒跑");
  release("好");
  await waitFor(() => channel.sends.length >= 2);
});

test("/stop：丟掉排隊中的訊息", async () => {
  const { agent, channel, model } = setupSlow();
  agent.handleMessage(msg("c1", "第一則"));
  await waitFor(() => model.requests.length >= 1);
  agent.handleMessage(msg("c1", "/help"));
  agent.handleMessage(msg("c1", "排在指令後面的"));
  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => channel.sends.length >= 2);
  await delay(20);
  assert.equal(model.requests.length, 1, "排隊中的文字不會再送給模型");
  assert.ok(channel.sends[0]?.includes("已停止"));
  assert.ok(channel.sends[1]?.includes("可用的指令"), "已排隊的指令照樣執行");
});

test("/stop：沒在處理時告知", async () => {
  const { agent, channel } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("沒有在處理"));
});

test("處理很久時：定期傳新的「處理中」，時間累計；做完後不再傳，也不刪改之前的", async () => {
  const { agent, channel, release } = setupSlow([echoTool], 30);
  agent.handleMessage(msg("c1", "長任務"));
  await waitFor(() => channel.statuses.length >= 2);

  assert.ok(channel.statuses.every((text) => text.startsWith("⏳ 處理中")));
  assert.equal(channel.edits.length, 0, "不改寫之前的訊息");

  release("做完了");
  await waitFor(() => channel.sends.length >= 1);
  const count = channel.statuses.length;
  await delay(80);
  assert.equal(channel.statuses.length, count, "做完後不再傳");
  assert.deepEqual(channel.sends, ["做完了"]);
});

test("heartbeatText：時間累計，以分鐘顯示", () => {
  assert.equal(heartbeatText(60_000), "⏳ 處理中 — 1 分鐘");
  assert.equal(heartbeatText(3 * 60_000), "⏳ 處理中 — 3 分鐘");
});

test("很快做完就不會出現「處理中」", async () => {
  const { agent, channel } = setup(() => rText("哈囉"));
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);
  await delay(20);
  assert.equal(channel.statuses.length, 0);
});

test("工具迴圈：呼叫工具後把結果送回模型，只傳最終回覆", async () => {
  const { agent, channel, model } = setup((i) => (i === 0 ? rTool("t1", "echo", { x: 1 }) : rText("完成")));
  agent.handleMessage(msg("c1", "做事"));
  await waitFor(() => channel.sends.length >= 1);

  assert.deepEqual(channel.sends, ["完成"], "只傳最終回覆，不傳中間的工具呼叫");
  assert.equal(model.requests.length, 2, "模型被呼叫兩次");
  // 第二次請求裡要有工具結果
  const secondRequest = model.requests[1];
  const lastMessage = secondRequest?.messages.at(-1);
  assert.equal(lastMessage?.role, "user");
  assert.equal(lastMessage?.content[0]?.type, "tool_result");
});

test("空內容：回報原因，且不會卡死——下一則訊息正常處理", async () => {
  const { agent, channel } = setup((i) => (i === 0 ? rEmpty("refusal") : rText("這次有回")));

  agent.handleMessage(msg("c1", "敏感請求"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("婉拒"), "要說明是婉拒");

  agent.handleMessage(msg("c1", "換個話題"));
  await waitFor(() => channel.sends.length >= 2);
  assert.equal(channel.sends[1], "這次有回", "下一則訊息要能正常得到回覆，不卡在被拒的請求上");
});

test("步數上限：一直呼叫工具時會停下來", async () => {
  const { agent, channel, model } = setup(() => rTool("t", "echo", {}), 3);
  agent.handleMessage(msg("c1", "無限工具"));
  await waitFor(() => channel.sends.length >= 1);

  assert.ok(channel.sends[0]?.includes("步數上限"));
  assert.equal(model.requests.length, 3, "到達上限就停，不超過 maxSteps");
});

test("/new：清掉目前對話，舊的留著", async () => {
  const { agent, channel } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);

  agent.handleMessage(msg("c1", "/new"));
  await waitFor(() => channel.sends.length >= 2);
  assert.ok(channel.sends[1]?.includes("已開新的對話"));
});

test("重新啟動：接回最近活動的那段，通知用戶，上下文接得上", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db");
  const deps = { tools: [], buildSystemPrompt: () => "測試", contextWindow: 200_000, maxSteps: 30 };

  // 第一次啟動：開兩段，第二段比較新
  const before = new FakeChannel();
  const first = createAgent({ ...deps, model: fakeModel(() => rText("好")), channel: before, store: openStore(dbPath) });
  first.handleMessage(msg("c1", "舊的那段"));
  await waitFor(() => before.sends.length >= 1);
  first.handleMessage(msg("c1", "/new"));
  first.handleMessage(msg("c1", "新的那段"));
  await waitFor(() => before.sends.length >= 3);
  assert.ok(before.sends[1]?.startsWith("✨"), "/new 回一則明顯的分隔訊息");

  // 重新啟動
  const after = new FakeChannel();
  const model = fakeModel(() => rText("接上了"));
  const second = createAgent({ ...deps, model, channel: after, store: openStore(dbPath) });
  await second.restoreAll();
  assert.equal(after.sends.length, 1);
  assert.ok(after.sends[0]?.includes("已重新啟動"));
  assert.ok(after.sends[0]?.includes("新的那段"), "接的是最近活動的那段");

  second.handleMessage(msg("c1", "繼續"));
  await waitFor(() => after.sends.length >= 2);
  const texts = model.requests[0]?.messages.flatMap((message) => message.content.map((block) => (block.type === "text" ? block.text : "")));
  assert.deepEqual(texts, ["新的那段", "好", "繼續"], "上下文是接回的那段");
});

test("重新啟動：沒有任何對話就不通知", async () => {
  const { agent, channel } = setup(() => rText("hi"));
  await agent.restoreAll();
  assert.equal(channel.sends.length, 0);
});

test("/resume：沒有對話時提示", async () => {
  const { agent, channel } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "/resume"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("還沒有可以恢復的對話"));
});

test("/rename 名稱：直接改名", async () => {
  const { agent, channel, store } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "你好"));
  await waitFor(() => channel.sends.length >= 1);

  agent.handleMessage(msg("c1", "/rename 我的任務"));
  await waitFor(() => channel.sends.length >= 2);
  assert.ok(channel.sends[1]?.includes("已命名為：我的任務"));
  assert.equal(store.listSessions("c1", 10)[0]?.title, "我的任務");
});

test("/rename 沒有對話內容時拒絕", async () => {
  const { agent, channel } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "/rename"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("目前沒有對話內容"));
});

test("/resume 清單用按鈕，點按鈕切換 session", async () => {
  const { agent, channel, store } = setup(() => rText("hi"));
  // 開第一段
  agent.handleMessage(msg("c1", "第一段對話"));
  await waitFor(() => channel.sends.length >= 1);
  const firstId = store.listSessions("c1", 10)[0]?.id ?? "";
  // 開新的一段，變成目前這段
  agent.handleMessage(msg("c1", "/new"));
  await waitFor(() => channel.sends.length >= 2);
  agent.handleMessage(msg("c1", "第二段對話"));
  await waitFor(() => channel.sends.length >= 3);

  // /resume 列清單（按鈕）
  agent.handleMessage(msg("c1", "/resume"));
  await waitFor(() => channel.buttons.length >= 1);
  const rows = channel.buttons[0]?.rows ?? [];
  assert.ok(rows.length >= 2, "兩段都列出來");

  // 點第一段的按鈕
  agent.handleAction({ chatId: "c1", userId: "u1", data: `resume:${firstId}`, messageId: "m1" });
  await waitFor(() => channel.edits.length >= 1);
  assert.ok(channel.edits[0]?.text.includes("已切換到"));
  assert.ok(channel.edits[0]?.text.includes("第一段對話"));
});

test("別的聊天室切不到自己的 session", async () => {
  const { agent, channel, store } = setup(() => rText("hi"));
  agent.handleMessage(msg("c1", "c1 的對話"));
  await waitFor(() => channel.sends.length >= 1);
  const id = store.listSessions("c1", 10)[0]?.id ?? "";

  agent.handleAction({ chatId: "c2", userId: "u2", data: `resume:${id}`, messageId: "m1" });
  await waitFor(() => channel.edits.length >= 1 || channel.sends.length >= 2);
  const output = channel.edits[0]?.text ?? channel.sends[1] ?? "";
  assert.ok(output.includes("找不到"), "別的聊天室應該找不到這段");
});

test("usageText：分開顯示快取讀寫和未快取的部分，最後是沒命中快取的總數（快取寫 + 未快取 + 輸出）", () => {
  assert.equal(
    usageText({ inputTokens: 1000, outputTokens: 50, cacheWriteTokens: 100, cacheReadTokens: 880 }),
    "用量：輸入 1000（快取讀 880、寫 100、未快取 20），輸出 50，新 170",
  );
});

test("usageText：完全沒命中快取時，新的就是輸入加輸出", () => {
  assert.equal(
    usageText({ inputTokens: 72888, outputTokens: 205, cacheWriteTokens: 72884, cacheReadTokens: 0 }),
    "用量：輸入 72888（快取讀 0、寫 72884、未快取 4），輸出 205，新 73093",
  );
});

// ── 凍結 system prompt ──

/** buildSystemPrompt 回傳 version.current，測試裡改它模擬「改了 prompt.ts」 */
function setupVersioned(dbPath = join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"), version = { current: "v1" }) {
  const channel = new FakeChannel();
  const model = fakeModel(() => rText("好"));
  let builds = 0;
  const agent = createAgent({
    model,
    channel,
    tools: [],
    store: openStore(dbPath),
    buildSystemPrompt: () => {
      builds++;
      return version.current;
    },
    contextWindow: 200_000,
    maxSteps: 30,
  });
  return { agent, channel, model, dbPath, version, builds: () => builds };
}

test("凍結：同一段對話中途 prompt 變了，照樣用第一次那份，也只產生一次", async () => {
  const { agent, channel, model, version, builds } = setupVersioned();
  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => channel.sends.length >= 1);
  version.current = "v2";
  agent.handleMessage(msg("c1", "二"));
  await waitFor(() => channel.sends.length >= 2);

  assert.deepEqual(model.requests.map((request) => request.system), ["v1", "v1"]);
  assert.equal(builds(), 1);
});

test("凍結：重啟後接回，用 DB 裡凍結的那份，不用新版", async () => {
  const first = setupVersioned();
  first.agent.handleMessage(msg("c1", "一"));
  await waitFor(() => first.channel.sends.length >= 1);

  const second = setupVersioned(first.dbPath, { current: "v2" });
  await second.agent.restoreAll();
  second.agent.handleMessage(msg("c1", "二"));
  await waitFor(() => second.channel.sends.length >= 2);
  assert.equal(second.model.requests[0]?.system, "v1");
});

test("凍結：/new 開的新對話用最新版", async () => {
  const { agent, channel, model, version } = setupVersioned();
  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => channel.sends.length >= 1);
  version.current = "v2";
  agent.handleMessage(msg("c1", "/new"));
  agent.handleMessage(msg("c1", "二"));
  await waitFor(() => channel.sends.length >= 3);
  assert.deepEqual(model.requests.map((request) => request.system), ["v1", "v2"]);
});

test("凍結：升級前就存在、還沒凍結的對話，接回後用當下的版本並存起來", async () => {
  const { agent, channel, dbPath } = setupVersioned();
  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => channel.sends.length >= 1);
  // 模擬舊資料：把凍結的版本清掉
  const store = openStore(dbPath);
  const sessionId = store.listSessions("c1", 1)[0]!.id;
  new DatabaseSync(dbPath).exec("UPDATE sessions SET system_prompt_hash = NULL");
  assert.equal(store.getSystemPrompt(sessionId), undefined);

  const after = setupVersioned(dbPath, { current: "v2" });
  await after.agent.restoreAll();
  after.agent.handleMessage(msg("c1", "二"));
  await waitFor(() => after.channel.sends.length >= 2);
  assert.equal(after.model.requests[0]?.system, "v2");
  assert.equal(store.getSystemPrompt(sessionId), "v2");
});

test("/reload_prompt：改用最新版，對話保留，重啟後也是新版", async () => {
  const first = setupVersioned();
  first.agent.handleMessage(msg("c1", "一"));
  await waitFor(() => first.channel.sends.length >= 1);
  first.version.current = "v22";
  first.agent.handleMessage(msg("c1", "/reload_prompt"));
  await waitFor(() => first.channel.sends.length >= 2);
  assert.ok(first.channel.sends[1]?.includes("已更新 system prompt（2 字 → 3 字）"), String(first.channel.sends[1]));

  first.agent.handleMessage(msg("c1", "二"));
  await waitFor(() => first.channel.sends.length >= 3);
  const request = first.model.requests[1]!;
  assert.equal(request.system, "v22");
  assert.equal(request.messages.length, 3, "對話紀錄保留");

  const second = setupVersioned(first.dbPath, { current: "v3" });
  await second.agent.restoreAll();
  second.agent.handleMessage(msg("c1", "三"));
  await waitFor(() => second.channel.sends.length >= 2);
  assert.equal(second.model.requests[0]?.system, "v22");
});

test("/reload_prompt：沒有變動、沒有對話時告知", async () => {
  const { agent, channel } = setupVersioned();
  agent.handleMessage(msg("c1", "/reload_prompt"));
  await waitFor(() => channel.sends.length >= 1);
  assert.ok(channel.sends[0]?.includes("目前沒有對話"));

  agent.handleMessage(msg("c1", "一"));
  agent.handleMessage(msg("c1", "/reload_prompt"));
  await waitFor(() => channel.sends.length >= 3);
  assert.ok(channel.sends[2]?.includes("已經是最新版"));
});

test("/reload_prompt：推論中打，這一輪照舊跑完，下一輪才換", async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"));
  const channel = new FakeChannel();
  const { model, release } = slowModel();
  const version = { current: "v1" };
  const agent = createAgent({
    model,
    channel,
    tools: [echoTool],
    store,
    buildSystemPrompt: () => version.current,
    contextWindow: 200_000,
    maxSteps: 30,
  });

  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => model.requests.length >= 1);
  version.current = "v2";
  agent.handleMessage(msg("c1", "/reload_prompt"));
  release(rTool("t1", "echo", {}));
  await waitFor(() => model.requests.length >= 2);
  assert.equal(model.requests[1]?.system, "v1", "同一輪的工具來回還是舊版");
  release("完成");
  await waitFor(() => channel.sends.some((text) => text.includes("已更新")));

  agent.handleMessage(msg("c1", "二"));
  await waitFor(() => model.requests.length >= 3);
  assert.equal(model.requests[2]?.system, "v2");
  // 收尾：讓這一輪做完，否則「輸入中」的計時器會讓測試程序結束不了
  release("好");
  await waitFor(() => channel.sends.includes("好"));
});

// ── 凍結工具清單 ──

const spec = (name: string, description = name) => ({ name, description, inputSchema: { type: "object" } });
const toolOf = (name: string, description = name): Tool => ({ spec: spec(name, description), run: async () => "ok" });

test("mergeTools：沒有凍結的版本就用目前的", () => {
  assert.deepEqual(mergeTools(undefined, [spec("a"), spec("b")]), [spec("a"), spec("b")]);
});

test("mergeTools：照凍結的順序，定義用目前的；移除的拿掉，新增的接在最後", () => {
  const pinned = [spec("b"), spec("a", "舊說明"), spec("gone")];
  const current = [spec("new"), spec("a", "新說明"), spec("b")];
  assert.deepEqual(mergeTools(pinned, current), [spec("b"), spec("a", "新說明"), spec("new")]);
});

test("凍結工具：第一次推論存進 DB；重啟後照凍結的順序，新增的接在最後", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db");
  const run = (tools: Tool[]) => {
    const channel = new FakeChannel();
    const model = fakeModel(() => rText("好"));
    const store = openStore(dbPath);
    const agent = createAgent({ model, channel, tools, store, buildSystemPrompt: () => "測試", contextWindow: 200_000, maxSteps: 30 });
    return { agent, channel, model, store };
  };

  const first = run([toolOf("a"), toolOf("b")]);
  first.agent.handleMessage(msg("c1", "一"));
  await waitFor(() => first.channel.sends.length >= 1);
  const sessionId = first.store.listSessions("c1", 1)[0]!.id;
  assert.deepEqual(first.store.getTools(sessionId), [spec("a"), spec("b")]);

  // 改了程式：順序換了、b 的說明改了、多了 c
  const second = run([toolOf("c"), toolOf("b", "新的 b"), toolOf("a")]);
  await second.agent.restoreAll();
  second.agent.handleMessage(msg("c1", "二"));
  await waitFor(() => second.channel.sends.length >= 2);
  const expected = [spec("a"), spec("b", "新的 b"), spec("c")];
  assert.deepEqual(second.model.requests[0]?.tools, expected);
  assert.deepEqual(second.store.getTools(sessionId), expected, "存回 DB");
});

test("凍結工具：/new 開的新對話直接用目前程式的順序", async () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"));
  const channel = new FakeChannel();
  const model = fakeModel(() => rText("好"));
  const tools = [toolOf("b"), toolOf("a")];
  const agent = createAgent({ model, channel, tools, store, buildSystemPrompt: () => "測試", contextWindow: 200_000, maxSteps: 30 });
  agent.handleMessage(msg("c1", "一"));
  await waitFor(() => channel.sends.length >= 1);
  assert.deepEqual(model.requests[0]?.tools, [spec("b"), spec("a")]);
});

// ── 核准按鈕 ──

/** 會問用戶的假工具：把核准結果當作工具結果回傳 */
function askingTool(answers: ApprovalAnswer[]): Tool {
  return {
    spec: { name: "ask", description: "問用戶", inputSchema: { type: "object", properties: {} } },
    run: async (_input, signal, context) => {
      if (!context) throw new Error("沒有 context");
      const answer = await context.requestApproval("🧠 想新增：甲", signal);
      answers.push(answer);
      return typeof answer === "string" ? answer : `cancelled:${answer.cancelled}`;
    },
  };
}

/** 第一次推論叫 ask 工具，之後回文字 */
function setupApproval() {
  const answers: ApprovalAnswer[] = [];
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bj-agent-")), "test.db"));
  const channel = new FakeChannel();
  const model = fakeModel((index) => (index === 0 ? rTool("t1", "ask", {}) : rText("好了")));
  const agent = createAgent({ model, channel, tools: [askingTool(answers)], store, buildSystemPrompt: () => "測試", contextWindow: 200_000, maxSteps: 30 });
  return { agent, channel, model, answers };
}

const toolResultOf = (request: ModelRequest | undefined) =>
  request?.messages.at(-1)?.content.find((block): block is Extract<Block, { type: "tool_result" }> => block.type === "tool_result")?.content;

test("核准：送出核准、拒絕按鈕，按核准後工具繼續，按鈕換成結果", async () => {
  const { agent, channel, model, answers } = setupApproval();
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.buttons.length >= 1);

  const sent = channel.buttons[0]!;
  assert.equal(sent.text, "🧠 想新增：甲");
  assert.deepEqual(sent.rows[0]?.map((button) => button.text), ["✅ 核准", "❌ 拒絕"]);

  agent.handleAction({ chatId: "c1", userId: "u1", data: sent.rows[0]![0]!.data, messageId: "btn1" });
  await waitFor(() => channel.sends.length >= 1);
  assert.deepEqual(answers, ["approved"]);
  assert.equal(toolResultOf(model.requests[1]), "approved");
  assert.deepEqual(channel.sends, ["好了"]);
  assert.deepEqual(channel.edits, [{ messageId: "btn1", text: "🧠 想新增：甲\n\n✅ 已核准" }]);
});

test("核准：按拒絕，工具收到 denied", async () => {
  const { agent, channel, answers } = setupApproval();
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.buttons.length >= 1);
  agent.handleAction({ chatId: "c1", userId: "u1", data: channel.buttons[0]!.rows[0]![1]!.data, messageId: "btn1" });
  await waitFor(() => channel.sends.length >= 1);
  assert.deepEqual(answers, ["denied"]);
  assert.match(channel.edits[0]!.text, /❌ 已拒絕$/);
});

test("核准：等待中傳新訊息，就當作沒核准，新訊息併進下一次推論", async () => {
  const { agent, channel, model, answers } = setupApproval();
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.buttons.length >= 1);

  agent.handleMessage(msg("c1", "算了不用"));
  await waitFor(() => channel.sends.length >= 1);
  assert.deepEqual(answers, [{ cancelled: "用戶傳了新訊息" }]);
  const last = model.requests[1]?.messages.at(-1);
  assert.deepEqual(
    last?.content.map((block) => block.type),
    ["tool_result", "text"],
    "工具結果和新訊息在同一個用戶回合",
  );
  assert.match(channel.edits[0]!.text, /⏹ 已取消（用戶傳了新訊息）$/);
});

test("核准：等待中打 /stop，就當作沒核准，這輪停下來", async () => {
  const { agent, channel, answers } = setupApproval();
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.buttons.length >= 1);

  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => answers.length >= 1 && channel.edits.length >= 1);
  assert.deepEqual(answers, [{ cancelled: "已被用戶中止" }]);
  assert.match(channel.edits[0]!.text, /⏹ 已取消（已被用戶中止）$/);
  assert.ok(channel.sends.some((text) => text.startsWith("⚡ 已停止")));
});

test("核准：按到失效的按鈕（重啟前的、已處理過的），改成失效說明", async () => {
  const { agent, channel } = setupApproval();
  agent.handleAction({ chatId: "c1", userId: "u1", data: "approval:999:yes", messageId: "old" });
  await waitFor(() => channel.edits.length >= 1);
  assert.deepEqual(channel.edits, [{ messageId: "old", text: "⏹ 這個請求已經失效，沒有寫入。" }]);
});

test("核准：別的聊天室按不到這個請求", async () => {
  const { agent, channel, answers } = setupApproval();
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.buttons.length >= 1);
  agent.handleAction({ chatId: "c2", userId: "u2", data: channel.buttons[0]!.rows[0]![0]!.data, messageId: "x" });
  await waitFor(() => channel.edits.length >= 1);
  assert.deepEqual(answers, [], "c1 的請求還在等");
  assert.match(channel.edits[0]!.text, /已經失效/);
  // 收尾：c1 還卡在等核准，不停掉的話計時器會讓測試程式結束不了
  agent.handleMessage(msg("c1", "/stop"));
  await waitFor(() => answers.length >= 1);
});

test("核准：通訊軟體不支援按鈕，直接當作沒核准", async () => {
  const { agent, channel, answers } = setupApproval();
  (channel as { sendButtons?: unknown }).sendButtons = undefined;
  agent.handleMessage(msg("c1", "記住甲"));
  await waitFor(() => channel.sends.length >= 1);
  assert.deepEqual(answers, [{ cancelled: "這個通訊軟體不支援按鈕" }]);
});
