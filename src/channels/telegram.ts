import { requireSetting } from "../config.ts";
import type { Channel, ChannelDefinition } from "../types.ts";
import { errorMessage, sleep } from "../util.ts";

type Chat = { id: number; type: string };
type Update = {
  update_id: number;
  message?: { text?: string; from?: { id: number }; chat: Chat };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: Chat } };
};

const MAX_MESSAGE_LENGTH = 4000; // Telegram 上限 4096
const MAX_BUTTON_TEXT = 60; // 太長在手機上會被截掉

export const telegram: ChannelDefinition = {
  id: "telegram",
  displayName: "Telegram",
  fields: [
    { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", secret: true, hint: "在 Telegram 找 @BotFather 建立 bot 取得" },
    {
      key: "allowedUserIds",
      label: "允許的 TG user ID（多個用逗號分隔）",
      secret: false,
      hint: "傳訊息給 @userinfobot 可以查到自己的 ID。只有這些帳號的私訊會被處理",
    },
  ],
  create: (settings) => {
    const allowed = new Set(
      requireSetting(settings, "allowedUserIds")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    );
    if (allowed.size === 0) throw new Error("至少要允許一個 TG user ID");
    return createTelegramChannel(requireSetting(settings, "TELEGRAM_BOT_TOKEN"), allowed);
  },
};

function createTelegramChannel(token: string, allowedUserIds: ReadonlySet<string>): Channel {
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method} 失敗：${json.description ?? response.status}`);
    return json.result;
  }

  return {
    async start(handlers) {
      // 只處理白名單帳號的私訊：這是唯一的門，任何人都找得到這個 bot。按鈕事件也要過同一道門
      const permitted = (userId: string, chat: Chat) => {
        if (chat.type === "private" && allowedUserIds.has(userId)) return true;
        console.warn(`忽略：帳號 ${userId}，聊天類型 ${chat.type}`);
        return false;
      };

      let offset = 0;
      for (;;) {
        try {
          const updates = await call<Update[]>("getUpdates", {
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
          });
          for (const update of updates) {
            offset = update.update_id + 1;

            const message = update.message;
            if (message?.text && message.from) {
              const userId = String(message.from.id);
              if (permitted(userId, message.chat)) {
                handlers.onMessage({ chatId: String(message.chat.id), userId, text: message.text });
              }
            }

            const query = update.callback_query;
            if (query) {
              // 不管處不處理都要回應，否則用戶那邊的按鈕會一直轉圈
              call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
              const userId = String(query.from.id);
              if (query.data && query.message && permitted(userId, query.message.chat)) {
                handlers.onAction({
                  chatId: String(query.message.chat.id),
                  userId,
                  data: query.data,
                  messageId: String(query.message.message_id),
                });
              }
            }
          }
        } catch (error) {
          console.error(`Telegram 收訊息失敗，3 秒後重試：${errorMessage(error)}`);
          await sleep(3000);
        }
      }
    },

    async send(chatId, text) {
      for (let start = 0; start < text.length; start += MAX_MESSAGE_LENGTH) {
        await call("sendMessage", { chat_id: chatId, text: text.slice(start, start + MAX_MESSAGE_LENGTH) });
      }
    },

    async typing(chatId) {
      await call("sendChatAction", { chat_id: chatId, action: "typing" });
    },

    async sendSilent(chatId, text) {
      await call("sendMessage", { chat_id: chatId, text: truncateChars(text, MAX_MESSAGE_LENGTH), disable_notification: true });
    },

    async sendButtons(chatId, text, rows) {
      const keyboard = rows.map((row) =>
        row.map((button) => ({ text: truncateChars(button.text, MAX_BUTTON_TEXT), callback_data: button.data })),
      );
      const sent = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: truncateChars(text, MAX_MESSAGE_LENGTH),
        reply_markup: { inline_keyboard: keyboard },
      });
      return String(sent.message_id);
    },

    async editMessage(chatId, messageId, text) {
      // 沒給 reply_markup，按鈕就會被移除
      await call("editMessageText", { chat_id: chatId, message_id: Number(messageId), text: truncateChars(text, MAX_MESSAGE_LENGTH) });
    },

    async setCommands(commands) {
      await call("setMyCommands", { commands: commands.map(({ name, description }) => ({ command: name, description })) });
    },
  };
}

function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}
