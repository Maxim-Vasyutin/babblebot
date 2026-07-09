/**
 * renderScreen — единая точка доставки всех клиентских UI-экранов.
 *
 * Логика (FEATURE_SPEC_02):
 * 1. Если есть uiMsgId → editMessageText; "not modified" игнорируем.
 * 2. Прочие ошибки edit → deleteMessage best-effort → sendMessage нового.
 * 3. Нет uiMsgId → sendMessage.
 * Возвращает message_id актуального UI-сообщения (сохранять в session.ui_message_id).
 */

import { deleteMessage, editMessageText, sendMessage } from "@/lib/telegram/api";
import type { SendMessageOptions } from "@/lib/telegram/api";

export async function deleteOldUi(
  chatId: number,
  uiMsgId: number | null | undefined
): Promise<void> {
  if (!uiMsgId) return;
  try {
    await deleteMessage(chatId, uiMsgId);
  } catch (err) {
    console.warn("delete_old_ui_failed", {
      chat_id: chatId,
      msg_id: uiMsgId,
      err: String(err),
    });
  }
}

export async function renderScreen(
  chatId: number,
  uiMsgId: number | null | undefined,
  text: string,
  options: SendMessageOptions = {}
): Promise<number> {
  if (uiMsgId) {
    try {
      await editMessageText(chatId, uiMsgId, text, options);
      return uiMsgId;
    } catch (err) {
      const desc = String(err);
      if (desc.includes("message is not modified")) {
        return uiMsgId;
      }
      // Сообщение удалено или старше 48 ч — отправляем новое.
      console.warn("render_screen_edit_failed", {
        chat_id: chatId,
        msg_id: uiMsgId,
        err: desc,
      });
      await deleteOldUi(chatId, uiMsgId);
    }
  }
  const result = await sendMessage(chatId, text, options);
  return result.message_id;
}
