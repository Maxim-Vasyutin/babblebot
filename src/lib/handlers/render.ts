/**
 * Функции доставки UI-экранов.
 *
 * editScreen  — для inline-кнопок: редактирует сообщение на месте.
 *               «not modified» проглатывает. При ошибке отправляет новое.
 * replaceScreen — для reply-кнопок и текстового ввода: удаляет старое сообщение
 *               (best-effort) и шлёт новое ниже.
 * deleteOldUi — best-effort удаление сообщения по id.
 */

import { deleteMessage, editMessageText, sendMessage } from "@/lib/telegram/api";
import type { SendMessageOptions } from "@/lib/telegram/api";

export async function deleteOldUi(
  chatId: number,
  liveMsgId: number | null | undefined
): Promise<void> {
  if (!liveMsgId) return;
  try {
    await deleteMessage(chatId, liveMsgId);
  } catch (err) {
    console.warn("delete_old_ui_failed", {
      chat_id: chatId,
      msg_id: liveMsgId,
      err: String(err),
    });
  }
}

/** Inline-кнопка: редактировать сообщение на месте. */
export async function editScreen(
  chatId: number,
  liveMsgId: number | null | undefined,
  text: string,
  options: SendMessageOptions = {}
): Promise<number> {
  if (liveMsgId) {
    try {
      await editMessageText(chatId, liveMsgId, text, options);
      return liveMsgId;
    } catch (err) {
      const desc = String(err);
      if (desc.includes("message is not modified")) {
        return liveMsgId;
      }
      console.warn("edit_screen_failed", {
        chat_id: chatId,
        msg_id: liveMsgId,
        err: desc,
      });
      // Сообщение удалено или старше 48 ч — отправляем новое.
    }
  }
  const result = await sendMessage(chatId, text, options);
  return result.message_id;
}

/** Reply-кнопка / текстовый ввод: удалить старое, прислать новое ниже. */
export async function replaceScreen(
  chatId: number,
  liveMsgId: number | null | undefined,
  text: string,
  options: SendMessageOptions = {}
): Promise<number> {
  await deleteOldUi(chatId, liveMsgId);
  const result = await sendMessage(chatId, text, options);
  return result.message_id;
}
