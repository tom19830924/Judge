import { ContextTooLongError, WARN_RATIO } from "./context.ts";
import { filterModels, groupModels, type ModelGroup } from "./models.ts";
import type { SessionInfo, Store } from "./store.ts";
import type { ApprovalAnswer, AskAnswer, Tool, ToolContext } from "./tools.ts";
import type {
  Button,
  Channel,
  Command,
  IncomingAction,
  IncomingMessage,
  Message,
  ModelClient,
  ModelResponse,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ToolSpec,
  Usage,
} from "./types.ts";
import { errorMessage } from "./util.ts";

type Dependencies = {
  model: ModelClient;
  channel: Channel;
  tools: Tool[];
  store: Store;
  /** 產生最新的 system prompt。每段 session 只在第一次推論和 /reload_prompt 時呼叫，之後用凍結的那份 */
  buildSystemPrompt: () => string;
  /** 目前模型的上下文上限（token） */
  contextWindow: number;
  /** 一則訊息最多跟模型來回幾次，避免無限循環 */
  maxSteps: number;
  /** 處理超過這麼久就顯示「處理中」，之後每隔這麼久更新一次（毫秒），預設 1 分鐘 */
  heartbeatMs?: number;
  /** /model 換模型：建立新的用戶端並回報上下文上限。沒給就不支援換模型 */
  switchModel?: (model: string) => { client: ModelClient; contextWindow: number };
};

/** 用戶按了哪個按鈕；沒按成（新訊息、/stop、送不出按鈕）就是 cancelled */
type Outcome = { choice: string } | { cancelled: string };

/** 等用戶按按鈕的請求（核准、選項都是） */
type Pending = {
  chatId: string;
  text: string;
  /** 按鈕那則訊息，用來把按鈕換成結果 */
  messageId: string | undefined;
  /** 每顆按鈕對應的值，callback_data 只帶索引（Telegram 上限 64 bytes） */
  values: string[];
  done: boolean;
  outcome?: Outcome;
  finish(outcome: Outcome): void;
  /** 結果要怎麼顯示在那則訊息上 */
  describe(outcome: Outcome): string;
};

/** 目前這段對話：session 資訊 + 送給模型的完整上下文 */
type Active = {
  info: SessionInfo;
  history: Message[];
  /** 凍結的 system prompt，存在 DB。undefined 表示還沒凍結，下一次推論時產生。 */
  systemPrompt: string | undefined;
  /** 這次執行要送的工具清單。undefined 表示還沒跟 DB 凍結的那份合併過，下一次推論時處理。 */
  tools: ToolSpec[] | undefined;
  /** 這段已經提醒過「快滿了」，不要每則都提醒 */
  warned: boolean;
};

const RESUME_LIST_SIZE = 10;
const RESUME_ACTION = "resume:";
/** /model 選單的按鈕資料：model:<第幾頁的第幾項>，意義看目前停在哪一層 */
const MODEL_ACTION = "model:";
/** 問用戶的按鈕資料：btn:<編號>:<第幾顆>。只帶索引，選項文字留在記憶體（Telegram 的 callback_data 上限 64 bytes） */
const BUTTON_ACTION = "btn:";
/** 一次最多顯示幾個選項，再多就塞不進一則訊息 */
export const MAX_ASK_OPTIONS = 20;
/** /model 第二層一頁最多幾個模型，超過就分頁 */
export const MODELS_PER_PAGE = 10;
const DEFAULT_TITLE_LENGTH = 30;
const MAX_TITLE_LENGTH = 60;
const DEFAULT_HEARTBEAT_MS = 60_000;
export const STOPPED_NOTE =
  "[系統備註] 上一輪處理被用戶用 /stop 中止，沒有做完。除非用戶要求，不要接著做；也不要回應或複述這則備註，直接處理用戶接下來的訊息。";

export const COMMANDS: Command[] = [
  { name: "stop", description: "停止目前正在做的事" },
  { name: "new", description: "開新的對話" },
  { name: "resume", description: "恢復之前的對話" },
  { name: "rename", description: "幫目前的對話取名稱，不帶名稱就由模型取" },
  { name: "model", description: "看目前的模型，或換一個" },
  { name: "reload_prompt", description: "目前的對話改用最新的 system prompt" },
];

export function createAgent(deps: Dependencies) {
  // 目前用的模型和它的上下文上限。/model 可以換掉，所以不是常數
  let model = deps.model;
  let contextWindow = deps.contextWindow;
  // 「目前在哪段」只存在記憶體；啟動時用 restoreAll 接回各聊天室最近活動的那段
  const active = new Map<string, Active>();
  const queues = new Map<string, Promise<void>>();
  /** 已排隊、還沒開始處理的文字訊息。陣列在開始處理前都還能再加 */
  const waiting = new Map<string, string[]>();
  /** 正在等模型回應的推論，收到新訊息時用來中止 */
  const thinking = new Map<string, AbortController>();
  /** 正在處理的這一輪（推論 + 工具），/stop 時用來中止 */
  const running = new Map<string, AbortController>();
  /** 等用戶按按鈕的請求。按鈕事件不排隊（排隊會等這輪做完，而這輪正在等按鈕） */
  const pendings = new Map<string, Pending>();
  let pendingSeq = 0;
  const toolsByName = new Map(deps.tools.map((tool) => [tool.spec.name, tool]));
  const toolSpecs = deps.tools.map((tool) => tool.spec);

  /** 同一個聊天室的訊息、指令、按鈕依序處理，前一件做完才處理下一件，避免做到一半被切換 session */
  function enqueue(chatId: string, task: () => Promise<void>): void {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous
      .then(() => withTyping(chatId, task))
      .catch(async (error: unknown) => {
        console.error(`[${chatId}] ${errorMessage(error)}`);
        await reply(chatId, describeError(error));
      });
    queues.set(chatId, next);
  }

  function handleMessage(message: IncomingMessage): void {
    const { chatId, text } = message;
    const command = parseCommand(text);
    if (command?.name === "stop") {
      // 不排隊，馬上處理，否則要等目前這輪做完才輪到
      stop(chatId);
      return;
    }
    if (command) {
      // 指令之後來的文字要排在指令後面，不能併進指令之前的那批
      waiting.delete(chatId);
      enqueue(chatId, () => runCommand(chatId, command.name, command.arg));
      return;
    }

    // 模型還在想的話就中止它：這次的訊息已經在上下文裡，會跟新訊息一起重新推論，只回一次
    thinking.get(chatId)?.abort();
    // 正在等按鈕的就當作沒回應，工具結果會告訴模型；新訊息照常在下一次推論前併進去
    cancelPendings(chatId, "用戶傳了新訊息");

    // 還沒開始處理的文字訊息併成一批，一起回
    const batch = waiting.get(chatId);
    if (batch) {
      batch.push(text);
      return;
    }
    const texts = [text];
    waiting.set(chatId, texts);
    enqueue(chatId, async () => {
      if (waiting.get(chatId) === texts) waiting.delete(chatId);
      // 已經在前一輪工具做完時被併進去了
      if (texts.length === 0) return;
      await respond(chatId, texts);
    });
  }

  function handleAction(action: IncomingAction): void {
    if (action.data.startsWith(BUTTON_ACTION)) {
      // 不排隊：這輪正卡在等這個按鈕
      void answerButton(action);
      return;
    }
    enqueue(action.chatId, async () => {
      if (action.data.startsWith(MODEL_ACTION)) return handleModelAction(action.chatId, action.data, action.messageId);
      if (!action.data.startsWith(RESUME_ACTION)) return;
      const result = resume(action.chatId, action.data.slice(RESUME_ACTION.length));
      // 把清單那則改成結果，按鈕跟著消失，避免之後誤點舊清單
      try {
        if (!deps.channel.editMessage) throw new Error("不支援改寫訊息");
        await deps.channel.editMessage(action.chatId, action.messageId, result);
      } catch {
        await reply(action.chatId, result);
      }
    });
  }

  // ── 問用戶（按鈕）──

  /**
   * 送出按鈕請用戶選，等他按。新訊息、/stop（signal）會讓它提早結束。
   * @param rows 每個內層陣列是一排按鈕，值就是回傳的 choice
   */
  async function askButtons(
    chatId: string,
    text: string,
    rows: { text: string; value: string }[][],
    describe: (outcome: Outcome) => string,
    signal?: AbortSignal,
  ): Promise<Outcome> {
    if (signal?.aborted) return { cancelled: "已被用戶中止" };
    if (!deps.channel.sendButtons) return { cancelled: "這個通訊軟體不支援按鈕" };
    const id = String(++pendingSeq);
    const values = rows.flat().map((button) => button.value);
    let index = 0;
    const keyboard = rows.map((row) => row.map((button) => ({ text: button.text, data: `${BUTTON_ACTION}${id}:${index++}` })));

    return new Promise<Outcome>((resolve) => {
      const onAbort = () => settlePending(id, { cancelled: "已被用戶中止" });
      const pending: Pending = { chatId, text, messageId: undefined, values, done: false, finish: () => {}, describe };
      pending.finish = (outcome) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      pendings.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      deps.channel.sendButtons!(chatId, text, keyboard).then(
        (messageId) => {
          pending.messageId = messageId ?? undefined;
          // 按鈕送出前就被取消了：補改訊息
          if (pending.done) void markPending(pending);
        },
        (error: unknown) => {
          console.error(`[${chatId}] 送按鈕失敗：${errorMessage(error)}`);
          settlePending(id, { cancelled: "送不出按鈕" });
        },
      );
    });
  }

  /** 送出核准、拒絕按鈕，等用戶按 */
  async function requestApproval(chatId: string, text: string, signal?: AbortSignal): Promise<ApprovalAnswer> {
    const rows = [
      [
        { text: "✅ 核准", value: "yes" },
        { text: "❌ 拒絕", value: "no" },
      ],
    ];
    const describe = (outcome: Outcome) =>
      "cancelled" in outcome ? `⏹ 已取消（${outcome.cancelled}）` : outcome.choice === "yes" ? "✅ 已核准" : "❌ 已拒絕";
    const outcome = await askButtons(chatId, text, rows, describe, signal);
    if ("cancelled" in outcome) return { cancelled: outcome.cancelled };
    return outcome.choice === "yes" ? "approved" : "denied";
  }

  /** 送出選項按鈕請用戶選，回傳他選的那個選項文字。一排一個，長清單比較好按 */
  async function askUser(chatId: string, question: string, options: string[], signal?: AbortSignal): Promise<AskAnswer> {
    if (options.length === 0) return { cancelled: "沒有提供選項" };
    const shown = options.slice(0, MAX_ASK_OPTIONS);
    const rows = shown.map((option) => [{ text: option, value: option }]);
    const describe = (outcome: Outcome) => ("cancelled" in outcome ? `⏹ 已取消（${outcome.cancelled}）` : `✅ ${outcome.choice}`);
    const outcome = await askButtons(chatId, question, rows, describe, signal);
    return "cancelled" in outcome ? outcome : { chosen: outcome.choice };
  }

  function settlePending(id: string, outcome: Outcome): void {
    const pending = pendings.get(id);
    if (!pending || pending.done) return;
    pending.done = true;
    pending.outcome = outcome;
    pendings.delete(id);
    pending.finish(outcome);
    void markPending(pending);
  }

  function cancelPendings(chatId: string, reason: string): void {
    for (const [id, pending] of pendings) {
      if (pending.chatId === chatId) settlePending(id, { cancelled: reason });
    }
  }

  /** 把按鈕訊息改成結果，按鈕跟著消失，避免重複按 */
  async function markPending(pending: Pending): Promise<void> {
    if (pending.messageId === undefined || !deps.channel.editMessage || !pending.outcome) return;
    try {
      await deps.channel.editMessage(pending.chatId, pending.messageId, `${pending.text}\n\n${pending.describe(pending.outcome)}`);
    } catch (error) {
      console.error(`[${pending.chatId}] 更新按鈕訊息失敗：${errorMessage(error)}`);
    }
  }

  async function answerButton(action: IncomingAction): Promise<void> {
    const [id, index] = action.data.slice(BUTTON_ACTION.length).split(":");
    const pending = id === undefined ? undefined : pendings.get(id);
    const choice = pending?.values[Number(index)];
    if (!pending || pending.chatId !== action.chatId || choice === undefined) {
      // 重啟前的舊按鈕，或已經處理過的
      try {
        await deps.channel.editMessage?.(action.chatId, action.messageId, "⏹ 這個請求已經失效，沒有生效。");
      } catch {
        // 改不了就算了
      }
      return;
    }
    pending.messageId ??= action.messageId;
    settlePending(id as string, { choice });
  }

  /** /stop：中止推論和正在跑的指令，還沒處理的文字訊息一併丟掉 */
  function stop(chatId: string): void {
    const turn = running.get(chatId);
    const dropped = waiting.get(chatId)?.splice(0).length ?? 0;
    waiting.delete(chatId);
    turn?.abort();
    console.log(`[${chatId}] /stop：${turn ? "中止目前這輪" : "沒有在處理"}，丟掉 ${dropped} 則排隊中的訊息`);
    void reply(chatId, turn || dropped > 0 ? "⚡ 已停止。可以繼續傳訊息。" : "目前沒有在處理的事。");
  }

  // ── 對話 ──

  async function respond(chatId: string, texts: string[]): Promise<void> {
    const turn = new AbortController();
    running.set(chatId, turn);
    const stopHeartbeat = startHeartbeat(chatId);
    try {
      await runTurn(chatId, texts, turn.signal);
    } finally {
      running.delete(chatId);
      stopHeartbeat();
    }
  }

  /**
   * 處理很久時讓用戶知道還活著：每隔一段時間傳一則新的「⏳ 處理中 — N 分鐘」，時間累計。
   * 只說還在處理，不說在做什麼；之前的訊息不改也不刪。失敗也不影響任務
   */
  function startHeartbeat(chatId: string): () => void {
    const interval = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let count = 0;
    const timer = setInterval(() => {
      count++;
      const text = heartbeatText(count * interval);
      const send = deps.channel.sendSilent?.bind(deps.channel) ?? deps.channel.send.bind(deps.channel);
      send(chatId, text).catch((error: unknown) => {
        console.error(`[${chatId}] 傳送處理中狀態失敗：${errorMessage(error)}`);
      });
    }, interval);
    return () => clearInterval(timer);
  }

  async function runTurn(chatId: string, texts: string[], stopped: AbortSignal): Promise<void> {
    const session = active.get(chatId) ?? startSession(chatId, texts[0] ?? "");
    appendUser(session, { role: "user", content: texts.map((text) => ({ type: "text", text })) });

    for (let step = 1; step <= deps.maxSteps; step++) {
      // 工具執行期間傳來的訊息，在下一次推論前併進來，不用等這輪做完
      if (step > 1) takeWaiting(chatId, session);
      const response = await think(chatId, session, stopped);
      if (stopped.aborted) return noteStopped(session);
      // 被新訊息打斷：不回覆。上下文停在用戶訊息（或工具結果），新訊息會併進去重新推論
      if (!response) return;

      if (response.content.length === 0) {
        // 推一個助理回合保持 user/assistant 交替，否則下一則訊息會被併進同一個 user turn，
        // 對同一個（可能被模型婉拒的）請求一直重試
        const note = emptyResponseNote(response.rawStopReason);
        append(session, { role: "assistant", content: [{ type: "text", text: note }] }, response.usage);
        await reply(chatId, note);
        return;
      }
      append(session, { role: "assistant", content: response.content }, response.usage);

      // 只把最後的回覆傳給用戶；中間過程（工具呼叫、伴隨的過場文字）只留在對話紀錄
      const calls = response.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
      if (calls.length === 0) {
        const said = textOf(response.content);
        if (said !== "") await reply(chatId, said);
        await warnIfNearlyFull(chatId, session);
        return;
      }

      // 每個工具呼叫都要有對應的結果，API 才會接受；被中止後剩下的就標成沒執行
      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        results.push(stopped.aborted ? skippedResult(call) : await runTool(chatId, call, stopped));
      }
      append(session, { role: "user", content: results });
      if (stopped.aborted) return noteStopped(session);
    }

    await reply(chatId, `已達單則訊息的步數上限（${deps.maxSteps}），先停在這裡。回覆「繼續」可以接著做。`);
    await warnIfNearlyFull(chatId, session);
  }

  /** 把排隊中的文字訊息併進目前的上下文。清空陣列，排好的那件工作看到空的就跳過 */
  function takeWaiting(chatId: string, session: Active): void {
    const texts = waiting.get(chatId);
    if (!texts) return;
    waiting.delete(chatId);
    appendUser(session, { role: "user", content: texts.splice(0).map((text) => ({ type: "text", text })) });
  }

  /**
   * 呼叫模型。期間收到新訊息或 /stop 會被中止，回傳 undefined；已經完成的工具呼叫和結果都留在上下文。
   * 回應剛好在中止的同時回來，也照樣丟掉
   */
  async function think(chatId: string, session: Active, stopped: AbortSignal): Promise<ModelResponse | undefined> {
    const controller = new AbortController();
    thinking.set(chatId, controller);
    const signal = AbortSignal.any([controller.signal, stopped]);
    try {
      const response = await model.complete({
        system: frozenPrompt(session),
        messages: session.history,
        tools: frozenTools(session),
        signal,
      });
      if (response.usage) console.log(`[${chatId}] ${usageText(response.usage)}`);
      return signal.aborted ? undefined : response;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      thinking.delete(chatId);
      if (controller.signal.aborted && !stopped.aborted) console.log(`[${chatId}] 收到新訊息，中止推論，合併後重新推論`);
    }
  }

  /**
   * 讓模型下次知道上一輪被中止。放在用戶這一側當系統備註，不放在助理的台詞裡，
   * 否則模型會把它當成自己說過的話，下一輪照著回給用戶。下一則用戶訊息會併進同一個用戶回合
   */
  function noteStopped(session: Active): void {
    appendUser(session, { role: "user", content: [{ type: "text", text: STOPPED_NOTE }] });
  }

  /** 這段凍結的 system prompt。還沒凍結就用最新版產生一份，存進 DB，之後每次推論、重啟後都用這份 */
  function frozenPrompt(session: Active): string {
    if (session.systemPrompt === undefined) {
      session.systemPrompt = deps.buildSystemPrompt();
      deps.store.setSystemPrompt(session.info.id, session.systemPrompt);
    }
    return session.systemPrompt;
  }

  /**
   * 這段凍結的工具清單。每次執行（啟動後）第一次用到時，跟 DB 裡的那份合併一次：
   * 還在的工具照原本的順序、用目前程式的定義，移除的拿掉，新增的接在最後面。有變動才存回 DB
   */
  function frozenTools(session: Active): ToolSpec[] {
    if (session.tools === undefined) {
      const pinned = deps.store.getTools(session.info.id);
      const merged = mergeTools(pinned, toolSpecs);
      if (pinned === undefined || JSON.stringify(pinned) !== JSON.stringify(merged)) {
        deps.store.setTools(session.info.id, merged);
        if (pinned !== undefined) console.log(`[${session.info.chatId}] 工具清單有變動，${session.info.id} 改用新版`);
      }
      session.tools = merged;
    }
    return session.tools;
  }

  /** 收到第一則訊息才建立 session，空的 session 不會留下來 */
  function startSession(chatId: string, firstText: string): Active {
    const title = shorten(firstText.replace(/\s+/g, " ").trim(), DEFAULT_TITLE_LENGTH) || "（沒有標題）";
    const session: Active = {
      info: deps.store.createSession(chatId, title, model.model),
      history: [],
      systemPrompt: undefined,
      tools: undefined,
      warned: false,
    };
    active.set(chatId, session);
    return session;
  }

  /** 存進資料庫、加進上下文、更新記憶體裡的 session 資訊 */
  function append(session: Active, message: Message, usage?: Usage | null): void {
    const inputTokens = usage?.inputTokens ?? null;
    deps.store.appendMessage(session.info.id, message, { model: model.model, inputTokens });
    session.history.push(message);
    session.info.messageCount++;
    session.info.updatedAt = new Date().toISOString();
    if (message.role === "assistant") session.info.model = model.model;
    if (inputTokens !== null) session.info.lastInputTokens = inputTokens;
  }

  /** 上一則已經是用戶訊息時（例如停在步數上限），上下文裡合併成一則，維持用戶與模型交替。資料庫照樣分開存，讀回來時再合併 */
  function appendUser(session: Active, message: Message & { role: "user" }): void {
    const last = session.history.at(-1);
    if (last?.role !== "user") return append(session, message);
    deps.store.appendMessage(session.info.id, message);
    last.content.push(...message.content);
    session.info.messageCount++;
    session.info.updatedAt = new Date().toISOString();
  }

  async function warnIfNearlyFull(chatId: string, session: Active): Promise<void> {
    const used = session.info.lastInputTokens;
    if (session.warned || used === null || used < contextWindow * WARN_RATIO) return;
    session.warned = true;
    await reply(
      chatId,
      `⚠️ 這段對話已用掉約 ${percent(used)} 的上下文（${formatTokens(used)} / ${formatTokens(contextWindow)} token）。` +
        "建議打 /new 開新的一段，超過上限就無法繼續了。",
    );
  }

  function toolContext(chatId: string): ToolContext {
    return {
      chatId,
      requestApproval: (text, signal) => requestApproval(chatId, text, signal),
      askUser: (question, options, signal) => askUser(chatId, question, options, signal),
    };
  }

  async function runTool(chatId: string, call: ToolCallBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    let content: string;
    let isError = false;
    try {
      const tool = toolsByName.get(call.name);
      if (!tool) throw new Error(`沒有這個工具：${call.name}`);
      content = await tool.run(call.input, signal, toolContext(chatId));
    } catch (error) {
      content = errorMessage(error);
      isError = true;
    }
    return { type: "tool_result", toolCallId: call.id, content: content || "（沒有輸出）", isError };
  }

  // ── 指令 ──

  async function runCommand(chatId: string, name: string, arg: string): Promise<void> {
    switch (name) {
      case "stop":
        return stop(chatId);
      case "new":
        active.delete(chatId);
        return reply(chatId, "✨ 已開新的對話。之前的對話都還在，打 /resume 可以切回去。");
      case "resume":
        return arg === "" ? showResumeList(chatId) : reply(chatId, resumeByNumber(chatId, arg));
      case "rename":
        return rename(chatId, arg);
      case "model":
        return showModelMenu(chatId, arg);
      case "reload_prompt":
        return reply(chatId, reloadPrompt(chatId));
      case "start":
      case "help":
        return reply(chatId, helpText());
      default:
        return reply(chatId, `不認識的指令：/${name}\n\n${helpText()}`);
    }
  }

  // ── /model ──

  /** /model 選單目前的狀態，只存記憶體；重啟後舊按鈕就失效 */
  type ModelMenu = { groups: ModelGroup[]; messageId: string };
  const modelMenus = new Map<string, ModelMenu>();

  async function showModelMenu(chatId: string, arg: string): Promise<void> {
    const current = `目前的模型：${model.model}（上下文上限 ${formatTokens(contextWindow)}）`;
    if (!deps.switchModel) return reply(chatId, `${current}\n\n這個服務商不支援在對話中換模型。`);

    let models: string[];
    try {
      if (!model.listModels) throw new Error("這個服務商沒有提供模型清單");
      models = filterModels(await model.listModels(), arg);
    } catch (error) {
      return reply(chatId, `${current}\n\n⚠️ 拿不到模型清單：${errorMessage(error)}\n打 /model 模型名稱 可以直接指定。`);
    }

    // 直接指定名稱：完全相符就換，不用再選
    if (arg !== "" && models.length === 1 && models[0] === arg) return applyModel(chatId, arg, undefined);
    if (models.length === 0) return reply(chatId, `${current}\n\n找不到符合「${arg}」的模型。`);

    const groups = groupModels(models);
    const header = arg === "" ? current : `${current}\n篩選：${arg}（${models.length} 個）`;
    // 只有一個廠商（通常是篩選過）就直接進第二層
    const rows = groups.length === 1 ? modelRows(groups, 0, 0) : vendorRows(groups);
    const text = groups.length === 1 ? `${header}\n\n${groups[0]!.vendor}：` : `${header}\n\n選廠商：`;
    if (!deps.channel.sendButtons) {
      return reply(chatId, `${current}\n\n可用的模型：\n${models.join("\n")}\n\n打 /model 模型名稱 切換。`);
    }
    const messageId = await deps.channel.sendButtons(chatId, text, rows);
    if (typeof messageId === "string") modelMenus.set(chatId, { groups, messageId });
  }

  function vendorRows(groups: ModelGroup[]): Button[][] {
    return groups.map((group, index) => [{ text: `${group.vendor}（${group.models.length}）`, data: `${MODEL_ACTION}v:${index}` }]);
  }

  /** 第二層：某個廠商的模型，一頁 MODELS_PER_PAGE 個，最後一排是翻頁和返回 */
  function modelRows(groups: ModelGroup[], vendorIndex: number, page: number): Button[][] {
    const group = groups[vendorIndex];
    if (!group) return vendorRows(groups);
    const pages = Math.max(1, Math.ceil(group.models.length / MODELS_PER_PAGE));
    const current = Math.min(Math.max(page, 0), pages - 1);
    const start = current * MODELS_PER_PAGE;
    const rows: Button[][] = group.models.slice(start, start + MODELS_PER_PAGE).map((name, offset) => [
      { text: `${name === model.model ? "▶ " : ""}${name}`, data: `${MODEL_ACTION}m:${vendorIndex}:${start + offset}` },
    ]);
    const nav: Button[] = [];
    if (current > 0) nav.push({ text: "◀ 上一頁", data: `${MODEL_ACTION}p:${vendorIndex}:${current - 1}` });
    // 只有一個廠商時（篩選過）返回也回到廠商清單，至少看得到全貌
    nav.push({ text: `⬅️ 返回${pages > 1 ? `（${current + 1}/${pages}）` : ""}`, data: `${MODEL_ACTION}back` });
    if (current < pages - 1) nav.push({ text: "下一頁 ▶", data: `${MODEL_ACTION}p:${vendorIndex}:${current + 1}` });
    rows.push(nav);
    return rows;
  }

  /** 點了 /model 選單的按鈕 */
  async function handleModelAction(chatId: string, data: string, messageId: string): Promise<void> {
    const menu = modelMenus.get(chatId);
    if (!menu) {
      await editOrSend(chatId, messageId, "⏹ 這份模型清單已經失效（可能重啟過），請重打 /model。");
      return;
    }
    menu.messageId = messageId;
    const [kind, first, second] = data.slice(MODEL_ACTION.length).split(":");
    if (kind === "back") return void (await editOrSend(chatId, messageId, "選廠商：", vendorRows(menu.groups)));
    if (kind === "v") return void (await editOrSend(chatId, messageId, vendorTitle(menu, Number(first)), modelRows(menu.groups, Number(first), 0)));
    if (kind === "p") {
      return void (await editOrSend(chatId, messageId, vendorTitle(menu, Number(first)), modelRows(menu.groups, Number(first), Number(second))));
    }
    if (kind === "m") {
      const name = menu.groups[Number(first)]?.models[Number(second)];
      if (name === undefined) return void (await editOrSend(chatId, messageId, "⏹ 找不到這個模型，請重打 /model。"));
      modelMenus.delete(chatId);
      return applyModel(chatId, name, messageId);
    }
  }

  function vendorTitle(menu: ModelMenu, vendorIndex: number): string {
    return `${menu.groups[vendorIndex]?.vendor ?? "模型"}（▶ 是目前用的）：`;
  }

  /** 真的換模型：換掉用戶端、更新上下文上限，並把結果回報給用戶 */
  async function applyModel(chatId: string, name: string, messageId: string | undefined): Promise<void> {
    if (!deps.switchModel) return reply(chatId, "這個服務商不支援在對話中換模型。");
    if (name === model.model) return void (await editOrSend(chatId, messageId, `已經在用 ${name} 了。`));

    let result: string;
    try {
      const switched = deps.switchModel(name);
      const before = model.model;
      model = switched.client;
      contextWindow = switched.contextWindow;
      console.log(`[${chatId}] /model：${before} → ${name}（上下文上限 ${contextWindow}）`);
      result = `✅ 已換成 ${name}（上下文上限 ${formatTokens(contextWindow)}）。\n所有對話都會用它，重啟後也是。這一次會重寫快取，費用比平常高。`;

      // 目前這段裝不裝得下新模型，先講清楚，免得下一則訊息才發現失敗
      const used = active.get(chatId)?.info.lastInputTokens ?? null;
      if (used !== null && used > contextWindow) {
        result += `\n\n⚠️ 目前這段約 ${formatTokens(used)} token，超過新模型的上限，請打 /new 開新的一段。`;
      } else if (used !== null && used >= contextWindow * WARN_RATIO) {
        result += `\n\n⚠️ 目前這段已用掉約 ${percent(used)} 的上下文，建議打 /new。`;
      }
    } catch (error) {
      result = `⚠️ 換不了模型：${errorMessage(error)}`;
    }
    await editOrSend(chatId, messageId, result);
  }

  /** 改寫按鈕那則訊息；沒有訊息 ID 或改寫失敗就另外傳一則 */
  async function editOrSend(chatId: string, messageId: string | undefined, text: string, rows?: Button[][]): Promise<void> {
    if (messageId !== undefined && deps.channel.editMessage) {
      try {
        await deps.channel.editMessage(chatId, messageId, text, rows);
        return;
      } catch (error) {
        console.error(`[${chatId}] 改寫訊息失敗：${errorMessage(error)}`);
      }
    }
    if (rows && deps.channel.sendButtons) {
      const sent = await deps.channel.sendButtons(chatId, text, rows);
      const menu = modelMenus.get(chatId);
      if (menu && typeof sent === "string") menu.messageId = sent;
      return;
    }
    await reply(chatId, text);
  }

  async function showResumeList(chatId: string): Promise<void> {
    const sessions = deps.store.listSessions(chatId, RESUME_LIST_SIZE);
    if (sessions.length === 0) return reply(chatId, "還沒有可以恢復的對話。");
    const currentId = active.get(chatId)?.info.id;
    const label = (session: SessionInfo) =>
      `${session.id === currentId ? "▶ " : ""}${session.title}・${formatTime(session.updatedAt)}`;

    if (deps.channel.sendButtons) {
      const rows = sessions.map((session) => [{ text: label(session), data: RESUME_ACTION + session.id }]);
      try {
        await deps.channel.sendButtons(chatId, "選擇要恢復的對話（▶ 是目前這段）：", rows);
        return;
      } catch (error) {
        console.error(`[${chatId}] 送按鈕失敗，改用文字清單：${errorMessage(error)}`);
      }
    }
    const lines = sessions.map((session, index) => `${index + 1}. ${label(session)}｜${session.messageCount} 則`);
    await reply(chatId, `最近的對話（▶ 是目前這段）：\n${lines.join("\n")}\n\n打 /resume 編號 切換，例如 /resume 2`);
  }

  /** 編號對應的是「現在」這份清單，跟 /resume 列出來的順序一樣 */
  function resumeByNumber(chatId: string, arg: string): string {
    const index = Number(arg);
    const sessions = deps.store.listSessions(chatId, RESUME_LIST_SIZE);
    const target = Number.isInteger(index) ? sessions[index - 1] : undefined;
    if (!target) return `沒有編號 ${arg} 的對話。打 /resume 看清單。`;
    return resume(chatId, target.id);
  }

  /**
   * 啟動時接回每個聊天室最近活動的 session，並通知用戶接的是哪段。
   * 不另外記「目前在哪段」：剛打 /new、還沒傳訊息就重啟的話，會接回 /new 之前那段
   */
  async function restoreAll(): Promise<void> {
    for (const chatId of deps.store.listChatIds()) {
      const latest = deps.store.listSessions(chatId, 1)[0];
      if (!latest) continue;
      const result = resume(chatId, latest.id);
      console.log(`[${chatId}] 啟動接回：${result}`);
      await reply(chatId, `🔄 已重新啟動，接續上次的對話。\n${result}`);
    }
  }

  /** 切換到指定的 session，回傳要告訴用戶的結果 */
  function resume(chatId: string, sessionId: string): string {
    const info = deps.store.getSession(chatId, sessionId);
    if (!info) return "找不到這段對話。";
    if (active.get(chatId)?.info.id === info.id) return `已經在這段了：${info.title}`;

    // 目前的模型裝不下就不切，免得切進去後每則訊息都失敗
    const used = info.lastInputTokens;
    if (used !== null && used > contextWindow) {
      return (
        `❌ 沒有切換：「${info.title}」約 ${formatTokens(used)} token，` +
        `超過目前模型（${model.model}）的上限 ${formatTokens(contextWindow)}。`
      );
    }

    const nearlyFull = used !== null && used >= contextWindow * WARN_RATIO;
    active.set(chatId, {
      info,
      history: deps.store.loadMessages(info.id),
      systemPrompt: deps.store.getSystemPrompt(info.id),
      tools: undefined,
      warned: nearlyFull,
    });
    let result = `已切換到：${info.title}（${info.messageCount} 則訊息）`;
    if (nearlyFull) result += `\n⚠️ 這段已用掉約 ${percent(used)} 的上下文，快滿了。`;
    return result;
  }

  /**
   * 目前這段改用最新的 system prompt，對話保留。指令跟訊息排同一個佇列，
   * 推論中打的話會等這一輪做完才換，一輪裡的每次推論都用同一份
   */
  function reloadPrompt(chatId: string): string {
    const session = active.get(chatId);
    if (!session) return "目前沒有對話。下一段對話開始時就會用最新的 system prompt。";
    const latest = deps.buildSystemPrompt();
    if (session.systemPrompt === latest) return "system prompt 已經是最新版，沒有變動。";

    const before = session.systemPrompt;
    session.systemPrompt = latest;
    deps.store.setSystemPrompt(session.info.id, latest);
    console.log(`[${chatId}] /reload_prompt：${session.info.id} 改用新版 system prompt`);
    const size = before === undefined ? `${latest.length} 字` : `${before.length} 字 → ${latest.length} 字`;
    return `✅ 已更新 system prompt（${size}），下一則訊息開始使用。這一次會重寫快取，費用比平常高。`;
  }

  async function rename(chatId: string, arg: string): Promise<void> {
    const session = active.get(chatId);
    if (!session || session.history.length === 0) return reply(chatId, "目前沒有對話內容，無法命名。");

    const title = arg !== "" ? shorten(arg, MAX_TITLE_LENGTH) : await suggestTitle(session.history);
    if (title === "") return reply(chatId, "模型沒有給出名稱，再試一次，或打 /rename 名稱 自己指定。");
    deps.store.renameSession(session.info.id, title);
    session.info.title = title;
    await reply(chatId, `已命名為：${title}`);
  }

  /**
   * 請模型幫對話取名稱。只送對話裡的文字，不送工具呼叫：
   * API 規定有工具呼叫的對話一定要附工具定義，而這次呼叫不該讓模型用工具。也不寫進對話紀錄
   */
  async function suggestTitle(history: Message[]): Promise<string> {
    const transcript = history
      .map((message) => {
        const text = textOf(message.content);
        return text === "" ? "" : `${message.role === "user" ? "用戶" : "助理"}：${text}`;
      })
      .filter((line) => line !== "")
      .join("\n\n");
    const excerpt = transcript.length > 20_000 ? `…（前面省略）\n${transcript.slice(-20_000)}` : transcript;

    const response = await model.complete({
      system: "你負責幫對話取名稱。只回名稱本身，20 字以內，用繁體中文，不要引號、標點或任何說明。",
      messages: [{ role: "user", content: [{ type: "text", text: `幫這段對話取名稱：\n\n${excerpt}` }] }],
      tools: [],
    });
    const firstLine = textOf(response.content).split("\n")[0] ?? "";
    return shorten(firstLine.replace(/^[「『"'\s]+|[」』"'\s。]+$/g, ""), MAX_TITLE_LENGTH);
  }

  // ── 傳送 ──

  /** 處理期間持續顯示「正在輸入中」（Telegram 約 5 秒就消失，所以每 4 秒重送）。失敗不影響任務 */
  async function withTyping(chatId: string, task: () => Promise<void>): Promise<void> {
    const typing = deps.channel.typing?.bind(deps.channel);
    if (!typing) return task();
    const ping = () => {
      typing(chatId).catch((error: unknown) => {
        console.error(`[${chatId}] 顯示輸入中失敗：${errorMessage(error)}`);
      });
    };
    ping();
    const timer = setInterval(ping, 4000);
    try {
      await task();
    } finally {
      clearInterval(timer);
    }
  }

  /** 傳送失敗只印出來，不中斷任務，避免對話紀錄停在只有工具呼叫、沒有結果的狀態 */
  async function reply(chatId: string, text: string): Promise<void> {
    try {
      await deps.channel.send(chatId, text);
    } catch (error) {
      console.error(`[${chatId}] 傳送失敗：${errorMessage(error)}`);
    }
  }

  function describeError(error: unknown): string {
    if (!(error instanceof ContextTooLongError)) return `⚠️ 發生錯誤：${errorMessage(error)}`;
    let text = "⚠️ 這段對話已經超過模型的上下文上限，無法繼續。請打 /new 開新的一段。";
    if (error.limit !== null && error.limit !== contextWindow) {
      text +=
        `\n\n另外，模型回報的實際上限是 ${formatTokens(error.limit)}，` +
        `但目前設定的是 ${formatTokens(contextWindow)}。` +
        `請在代理人資料夾的 config.json 的 provider.settings 加上 "contextWindow": "${error.limit}"，重啟後生效。`;
    }
    return text;
  }

  function percent(used: number | null): string {
    return `${Math.round(((used ?? 0) / contextWindow) * 100)}%`;
  }

  return { handleMessage, handleAction, restoreAll };
}

/** "/resume 2" → { name: "resume", arg: "2" }。Telegram 在群組裡會帶 @bot名稱，一併去掉 */
function parseCommand(text: string): { name: string; arg: string } | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

function helpText(): string {
  return ["可用的指令：", ...COMMANDS.map((command) => `/${command.name}：${command.description}`)].join("\n");
}

function textOf(content: Message["content"]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function skippedResult(call: ToolCallBlock): ToolResultBlock {
  return { type: "tool_result", toolCallId: call.id, content: "未執行：用戶已用 /stop 中止", isError: true };
}

/** 以字元計（中文、emoji 不會被切壞） */
function shorten(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("") + "…";
}

/** 「⏳ 處理中 — 3 分鐘」。不足一分鐘（只有測試會用到這麼短的間隔）顯示秒數 */
export function heartbeatText(elapsedMs: number): string {
  const elapsed = elapsedMs >= 60_000 ? `${Math.round(elapsedMs / 60_000)} 分鐘` : `${Math.round(elapsedMs / 1000)} 秒`;
  return `⏳ 處理中 — ${elapsed}`;
}

/** 11/19 15:03，本機時間 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** 模型回空內容時，把真正的原因講清楚，不要只說「沒有回應」讓人瞎猜 */
function emptyResponseNote(rawStopReason: string | null): string {
  if (rawStopReason === "refusal") {
    return "⚠️ 模型婉拒了這個請求（refusal），沒有產生內容。換個說法或換個任務再試。";
  }
  const reason = rawStopReason ? `（stop_reason: ${rawStopReason}）` : "";
  return `⚠️ 模型這回合沒有產生內容${reason}。可以直接再傳一次。`;
}

/** log 用：這次送進去多少、其中多少從快取讀、多少寫入快取 */
/**
 * 「新 N」：這次請求加回覆中沒命中快取的部分，也就是輸入扣掉快取讀，再加上輸出。
 * 快取寫算進去，因為那是這次第一次送、還沒被快取的內容
 */
export function usageText(usage: Usage): string {
  const fresh = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const uncached = usage.inputTokens - usage.cacheReadTokens + usage.outputTokens;
  return `用量：輸入 ${usage.inputTokens}（快取讀 ${usage.cacheReadTokens}、寫 ${usage.cacheWriteTokens}、未快取 ${fresh}），輸出 ${usage.outputTokens}，新 ${uncached}`;
}

/**
 * 凍結的工具清單和目前程式的工具合併（參考 Hermes 的 restore_agent_tool_prefix）。
 * 順序盡量照凍結的，前面沒變的部分還能命中快取；定義一律用目前的，避免照舊參數呼叫改過的程式
 */
export function mergeTools(pinned: ToolSpec[] | undefined, current: ToolSpec[]): ToolSpec[] {
  if (pinned === undefined) return current;
  const byName = new Map(current.map((tool) => [tool.name, tool]));
  const kept = pinned.flatMap((tool) => byName.get(tool.name) ?? []);
  const keptNames = new Set(kept.map((tool) => tool.name));
  return [...kept, ...current.filter((tool) => !keptNames.has(tool.name))];
}
