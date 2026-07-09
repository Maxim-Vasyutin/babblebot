/**
 * Обновление табло листа ожидания в admin-чате.
 *
 * Табло — одно сообщение в день (Europe/Moscow). При каждом клике «хочу»
 * по кончившейся позиции (sold_out) бот обновляет это сообщение редактированием.
 * Если сообщение удалили — шлёт новое и запоминает id.
 */

import { editMessageText, sendMessage } from "@/lib/telegram/api";
import {
  getDemandEventsToday,
  getWaitlistInfo,
  setWaitlistInfo,
} from "@/lib/supabase/queries";

function moscowDateString(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, "0");
  const d = String(msk.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildWaitlistText(
  items: Array<{ title: string; count: number }>
): string {
  const lines = ["⏳ Ждут сегодня:"];
  for (const it of items) {
    lines.push(`${it.title} — ${it.count}`);
  }
  return lines.join("\n");
}

/**
 * Обновить (или создать) табло ожидания в admin-чате.
 * Вызывается после записи demand_event с kind='sold_out'.
 */
export async function updateWaitlistBoard(adminChatId: number): Promise<void> {
  const waited = await getDemandEventsToday("sold_out");
  if (waited.length === 0) return;

  const today = moscowDateString();
  const text = buildWaitlistText(waited);
  const info = await getWaitlistInfo();

  if (info && info.date === today && info.message_id) {
    try {
      await editMessageText(adminChatId, info.message_id, text);
      return;
    } catch {
      // Message deleted or too old — fall through to send new
    }
  }

  const res = await sendMessage(adminChatId, text);
  await setWaitlistInfo(res.message_id, today);
}
