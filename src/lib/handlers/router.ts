/**
 * Маршрутизатор входящих Telegram Update.
 *
 * Правила разделения (SPEC.md, Блок 5):
 * - chat.type == "private" → клиентский поток.
 * - chat в группе с chat.id == admin_chat_id → admin-поток.
 * - /init в ЛЮБОЙ группе → admin-поток (единственная команда, работающая до
 *   первой привязки).
 *
 * answerCallbackQuery для КАЖДОГО callback дёргается ТУТ в finally, чтобы не
 * забыть в конкретном хендлере (SPEC.md, Блок 6 #2). Если хендлер сам захотел
 * показать текстовый toast — он уже вызвал answerCallbackQuery раньше; повторный
 * вызов Telegram проигнорирует.
 */

import type { TgUpdateT } from "@/lib/schemas";
import { answerCallbackQuery } from "@/lib/telegram/api";
import { getAdminChatId, getOrCreateSession } from "@/lib/supabase/queries";
import { handleClientUpdate } from "./client";
import { handleAdminUpdate } from "./admin";

export async function routeUpdate(update: TgUpdateT): Promise<void> {
  const cb = update.callback_query;
  const msg = update.message;

  try {
    // 1. Callback_query: определяем поток по chat.id.
    if (cb) {
      const chat = cb.message?.chat;
      if (!chat) return;
      if (chat.type === "private") {
        // Клиентский callback.
        const session = await getOrCreateSession(cb.from.id, cb.from.username);
        await handleClientUpdate(update, session);
      } else {
        // Group/supergroup — только admin.
        const adminChatId = await getAdminChatId();
        await handleAdminUpdate(update, adminChatId);
      }
      return;
    }

    // 2. Обычное сообщение.
    if (msg) {
      const chat = msg.chat;
      if (chat.type === "private") {
        if (!msg.from) return;
        const session = await getOrCreateSession(msg.from.id, msg.from.username);
        await handleClientUpdate(update, session);
        return;
      }
      // Group/supergroup: admin-поток. /init работает даже без привязки.
      if (chat.type === "group" || chat.type === "supergroup") {
        const adminChatId = await getAdminChatId();
        await handleAdminUpdate(update, adminChatId);
        return;
      }
      // Канал и прочее — игнор.
    }
  } finally {
    // Гасим «часики» на кнопке ВСЕГДА, даже если хендлер упал.
    if (cb) {
      try {
        await answerCallbackQuery(cb.id);
      } catch (err) {
        console.warn("answer_callback_failed_final", {
          cb_id: cb.id,
          err: String(err),
        });
      }
    }
  }
}
