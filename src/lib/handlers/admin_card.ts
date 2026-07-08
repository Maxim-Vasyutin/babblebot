/**
 * Формирование и отправка карточки заказа в admin-чат.
 *
 * Формат текста — SPEC.md, Блок 3:
 *   🆕 <b>Заказ #N</b> · HH:MM
 *   • Айс-латте (с сиропом) ×2
 *   • Сэндвич сыр-ветчина ×1
 *   <b>Итого: 750 ₽</b> · 💵 наличные
 *   🚗 белая гранта а123вс · середина очереди
 *   👤 @driver_ivan
 *
 * При смене статуса (in_progress / delivered / cancelled) обновляем шапку и
 * добавляем строку «⏱ взял @courier 14:35» / «✅ доставлен 14:48».
 * После delivered/cancelled кнопки убираем.
 */

import { editMessageText, sendMessage } from "@/lib/telegram/api";
import type { OrderRow } from "@/types/database";
import { esc } from "@/lib/telegram/escape";
import {
  formatRub,
  moscowHhMm,
  paymentLabel,
  renderBulletLines,
  userTag,
} from "./format";
import {
  keyboardForOrderStatus,
} from "@/lib/telegram/keyboards";

// ============================================================================
// Отрисовка текста
// ============================================================================

/** Значок статуса в шапке карточки. */
function statusIcon(status: OrderRow["status"]): string {
  switch (status) {
    case "new":
      return "🆕";
    case "in_progress":
      return "🚚";
    case "delivered":
      return "✅";
    case "cancelled":
      return "❌";
  }
}

/** Строка-хвост про кто/когда взял/доставил/отменил. */
function statusTail(order: OrderRow): string | null {
  if (order.status === "new") return null;
  const t = moscowHhMm(new Date(order.updated_at));
  const who = order.handled_by ? `@${esc(order.handled_by)}` : "курьер";
  switch (order.status) {
    case "in_progress":
      return `⏱ взял ${who} ${t}`;
    case "delivered":
      return `✅ доставлен ${t}`;
    case "cancelled":
      return `❌ отменён ${t}`;
    default:
      return null;
  }
}

export function renderOrderCard(order: OrderRow): string {
  const created = moscowHhMm(new Date(order.created_at));
  const icon = statusIcon(order.status);
  const total = formatRub(order.total_kop);
  const pay = paymentLabel(order.payment_method);
  const bullets = renderBulletLines(order.items);

  const lines: string[] = [
    `${icon} <b>Заказ #${order.order_number}</b> · ${created}`,
    bullets,
    `<b>Итого: ${total}</b> · ${pay}`,
    `🚗 ${esc(order.car)} · ${esc(order.landmark)}`,
    `👤 ${userTag(order.username, order.user_id)}`,
  ];
  const tail = statusTail(order);
  if (tail) lines.push(tail);
  return lines.join("\n");
}

// ============================================================================
// Отправка / редактирование
// ============================================================================

/**
 * Отправить новую карточку в admin-чат. Возвращает message_id (для записи в
 * orders.admin_message_id). null — если не удалось.
 */
export async function sendOrderCard(
  adminChatId: number,
  order: OrderRow
): Promise<number | null> {
  const text = renderOrderCard(order);
  try {
    const res = await sendMessage(adminChatId, text, {
      reply_markup: keyboardForOrderStatus(order.id, order.status),
      disable_web_page_preview: true,
    });
    return res.message_id;
  } catch (err) {
    console.error("send_order_card_failed_inner", {
      order_id: order.id,
      err: String(err),
    });
    return null;
  }
}

/**
 * Обновить карточку заказа при смене статуса. Правит текст и клавиатуру у того
 * же message_id (не шлёт новое сообщение).
 */
export async function editOrderCard(
  adminChatId: number,
  order: OrderRow
): Promise<void> {
  if (!order.admin_message_id) {
    console.warn("edit_order_card_no_message_id", { order_id: order.id });
    return;
  }
  const text = renderOrderCard(order);
  await editMessageText(adminChatId, order.admin_message_id, text, {
    reply_markup: keyboardForOrderStatus(order.id, order.status),
    disable_web_page_preview: true,
  });
}
