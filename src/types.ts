// 與服務商、通訊軟體無關的共用型別。各服務商、通訊軟體負責和自己的格式互轉。

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; toolCallId: string; content: string; isError: boolean };
export type Block = TextBlock | ToolCallBlock | ToolResultBlock;

// 用戶訊息不可能含工具呼叫、模型回應不可能含工具結果，由型別直接擋掉
export type UserMessage = { role: "user"; content: (TextBlock | ToolResultBlock)[] };
export type AssistantMessage = { role: "assistant"; content: (TextBlock | ToolCallBlock)[] };
export type Message = UserMessage | AssistantMessage;

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

/** signal 中止時，complete 要盡快放棄並丟出錯誤（例如推論中用戶又傳了新訊息） */
export type ModelRequest = { system: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal };
export type StopReason = "end" | "tool_use" | "max_tokens" | "other";
// rawStopReason 保留服務商回傳的原始字串（stopReason 只是歸類），空內容時才查得出真正原因
// usage 是 null 表示服務商沒回報用量；inputTokens 已包含快取讀寫的部分，就是這次送進去的總量
// cacheWriteTokens / cacheReadTokens 是其中寫入快取、從快取讀取的部分，用來看快取有沒有效
export type Usage = { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };
export type ModelResponse = {
  content: AssistantMessage["content"];
  stopReason: StopReason;
  rawStopReason: string | null;
  usage: Usage | null;
};

export interface ModelClient {
  /** 模型名稱，記進 session、查上下文上限用 */
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  /** 服務商提供的模型清單。不支援的服務商不實作，呼叫端要自己處理 */
  listModels?(): Promise<string[]>;
}

export type IncomingMessage = { chatId: string; userId: string; text: string };
/** 用戶點了訊息上的按鈕。data 是送按鈕時附的資料，messageId 是按鈕所在的那則訊息 */
export type IncomingAction = { chatId: string; userId: string; data: string; messageId: string };
export type Button = { text: string; data: string };
export type Command = { name: string; description: string };

export type ChannelHandlers = {
  onMessage(message: IncomingMessage): void;
  onAction(action: IncomingAction): void;
};

export interface Channel {
  /** 持續接收訊息，不會結束 */
  start(handlers: ChannelHandlers): Promise<never>;
  send(chatId: string, text: string): Promise<void>;
  /** 顯示「正在輸入中」。效果只維持幾秒，呼叫端要定期重送；不支援的通訊軟體可以不實作 */
  typing?(chatId: string): Promise<void>;
  /** 傳一則附按鈕的訊息，每個內層陣列是一排，回傳訊息 ID（之後改寫用）。不支援按鈕的通訊軟體不實作，呼叫端改用文字 */
  sendButtons?(chatId: string, text: string, rows: Button[][]): Promise<string | void>;
  /** 傳一則不跳通知的狀態訊息（例如「處理中」）。不支援的通訊軟體不實作，呼叫端改用 send */
  sendSilent?(chatId: string, text: string): Promise<void>;
  /** 改寫一則已送出的訊息。不給 rows 時按鈕會被移除，給了就換成新的按鈕 */
  editMessage?(chatId: string, messageId: string, text: string, rows?: Button[][]): Promise<void>;
  /** 註冊指令選單（輸入框旁的指令清單） */
  setCommands?(commands: Command[]): Promise<void>;
}

/** 初始設定時要問用戶的欄位。secret 欄位存進 .env（key 即環境變數名稱），其餘存進設定檔 */
export type SetupField = { key: string; label: string; secret: boolean; default?: string; hint?: string };
export type Settings = Record<string, string>;

export type ProviderDefinition = {
  id: string;
  displayName: string;
  fields: SetupField[];
  create(settings: Settings): ModelClient;
};

export type ChannelDefinition = {
  id: string;
  displayName: string;
  fields: SetupField[];
  create(settings: Settings): Channel;
};
