/**
 * Admin-поток (сообщения/callback из рабочей группы с chat.id == admin_chat_id).
 *
 * Команды:
 *   /init  — привязать текущий чат как admin_chat_id.
 *            Сохраняем `admin_bound_by` = from.id первого /init.
 *            Повторный /init из другого чата с другим from.id → «Чат уже привязан»
 *            (SPEC.md, Блок 6 #17).
 *   /стоп  — клавиатура наличия позиций (adm_stop:<slug>).
 *   /стат  — дневная сводка (Europe/Moscow).
 *
 * Callback:
 *   adm_stop:<slug>                    — переключить наличие
 *   adm_status:<order_uuid>:<status>   — сменить статус заказа
 */

import type { TgUpdateT, TgCallbackQueryT, TgMessageT } from "@/lib/schemas";
import { CallbackData } from "@/lib/schemas";
import {
  editMessageText,
  sendMessage,
} from "@/lib/telegram/api";
import { supabase } from "@/lib/supabase/client";
import {
  getDailyStats,
  getMenuItems,
  getOrderById,
  setAdminChatId,
  toggleAvailability,
  updateOrderStatus,
} from "@/lib/supabase/queries";
import type { OrderStatus, PaymentMethod } from "@/types/database";
import { stopKeyboard } from "@/lib/telegram/keyboards";
import { formatRub } from "./format";
import { editOrderCard } from "./admin_card";

// ============================================================================
// Точка входа
// ============================================================================

/**
 * @param update — валидированный Update.
 * @param adminChatId — актуальный admin_chat_id из БД (null, если не привязан).
 *                     /init разрешён даже при null (это первичная привязка).
 */
export async function handleAdminUpdate(
  update: TgUpdateT,
  adminChatId: bigint | null
): Promise<void> {
  if (update.callback_query) {
    await handleAdminCallback(update.callback_query, adminChatId);
    return;
  }
  if (update.message) {
    await handleAdminMessage(update.message, adminChatId);
  }
}

// ============================================================================
// Сообщения
// ============================================================================

async function handleAdminMessage(
  msg: TgMessageT,
  adminChatId: bigint | null
): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  if (!text) return;

  // /init — единственная команда, работающая из ЛЮБОЙ группы.
  if (text === "/init") {
    await handleInit(msg, adminChatId);
    return;
  }

  // Прочие admin-команды — только из уже привязанного чата.
  if (adminChatId === null || BigInt(chatId) !== adminChatId) {
    // Из чужой группы — молча игнор (чтобы не оставлять следов бота).
    return;
  }

  if (text === "/стоп" || text === "/stop") {
    await handleStop(chatId);
    return;
  }

  if (text === "/стат" || text === "/stat") {
    await handleStat(chatId);
    return;
  }
}

// ============================================================================
// /init: привязка admin-чата
// ============================================================================

async function handleInit(
  msg: TgMessageT,
  adminChatId: bigint | null
): Promise<void> {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  if (!fromId) return;

  try {
    // Прочитать текущего binder'а (может отсутствовать).
    const { data: bindRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "admin_bound_by")
      .maybeSingle();
    const boundBy = bindRow?.value ? Number(bindRow.value) : null;

    // Если чат уже привязан ИМЕННО этот — просто переподтверждаем.
    if (adminChatId !== null && BigInt(chatId) === adminChatId) {
      await sendMessage(chatId, "✅ Этот чат уже рабочий.");
      return;
    }

    // Если привязан другой чат и первичный binder существует и это не он —
    // отказываем.
    if (adminChatId !== null && boundBy !== null && boundBy !== fromId) {
      await sendMessage(chatId, "Чат уже привязан.");
      return;
    }

    // Разрешено: перепривязываем.
    await setAdminChatId(chatId);
    // Первый /init фиксирует admin_bound_by (или обновляет, если binder тот же).
    await supabase.from("app_settings").upsert(
      { key: "admin_bound_by", value: String(fromId) },
      { onConflict: "key" }
    );
    await sendMessage(chatId, "✅ Этот чат — рабочий.");
  } catch (err) {
    console.error("admin_init_failed", { chat_id: chatId, err: String(err) });
    try {
      await sendMessage(chatId, "⚠️ Не удалось привязать чат. Повторите.");
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// /стоп: наличие
// ============================================================================

async function handleStop(chatId: number): Promise<void> {
  try {
    const items = await getMenuItems();
    await sendMessage(chatId, "Наличие позиций (тап — переключить):", {
      reply_markup: stopKeyboard(items),
    });
  } catch (err) {
    console.error("admin_stop_failed", { err: String(err) });
    try {
      await sendMessage(chatId, "⚠️ Не удалось загрузить позиции.");
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// /стат: сводка дня
// ============================================================================

async function handleStat(chatId: number): Promise<void> {
  try {
    const stats = await getDailyStats();
    if (stats.count === 0 && stats.top_demand.length === 0) {
      await sendMessage(chatId, "Сегодня пока пусто.");
      return;
    }
    const date = moscowDate();
    const lines: string[] = [];
    lines.push(`📊 <b>Сегодня (${date}):</b>`);
    lines.push(
      `Заказов: ${stats.count} · Выручка: ${formatRub(stats.total_kop)}`
    );
    const p = stats.by_payment;
    const paymentPieces: string[] = [];
    if (p.cash > 0) paymentPieces.push(`💵 нал: ${formatRub(p.cash)}`);
    if (p.sbp > 0) paymentPieces.push(`📱 СБП: ${formatRub(p.sbp)}`);
    if (p.terminal > 0)
      paymentPieces.push(`💳 терминал: ${formatRub(p.terminal)}`);
    if (paymentPieces.length > 0) lines.push(paymentPieces.join(" · "));

    if (stats.top_items.length > 0) {
      lines.push("");
      lines.push("🔥 <b>Заказывали:</b>");
      lines.push(
        stats.top_items
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.qty}`)
          .join(" · ")
      );
    }

    if (stats.top_demand.length > 0) {
      lines.push("");
      lines.push("👀 <b>Хотели (нет в наличии):</b>");
      lines.push(
        stats.top_demand
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.clicks}`)
          .join(" · ")
      );
    }

    await sendMessage(chatId, lines.join("\n"));
    // Успокоить линтер по неиспользуемому PaymentMethod-импорту (типовая ссылка).
    void (0 as unknown as PaymentMethod);
  } catch (err) {
    console.error("admin_stat_failed", { err: String(err) });
    try {
      await sendMessage(chatId, "⚠️ Не удалось собрать сводку.");
    } catch {
      /* ignore */
    }
  }
}

function moscowDate(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const d = msk.getUTCDate();
  const m = msk.getUTCMonth();
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  return `${d} ${months[m]}`;
}

// ============================================================================
// Callbacks
// ============================================================================

async function handleAdminCallback(
  cb: TgCallbackQueryT,
  adminChatId: bigint | null
): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId) return;

  // Все admin-callback'и допускаются ТОЛЬКО из привязанного admin-чата.
  if (adminChatId === null || BigInt(chatId) !== adminChatId) {
    return;
  }

  const raw = cb.data ?? "";
  const parsed = CallbackData.safeParse(raw);
  if (!parsed.success) return;
  const [action, arg1, arg2] = raw.split(":");

  try {
    if (action === "adm_stop") {
      await handleAdmStop(chatId, cb, arg1);
      return;
    }
    if (action === "adm_status") {
      await handleAdmStatus(chatId, cb, arg1, arg2);
      return;
    }
  } catch (err) {
    console.error("admin_callback_failed", { action, err: String(err) });
  }
}

async function handleAdmStop(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined
): Promise<void> {
  if (!slug) return;
  await toggleAvailability(slug);
  const items = await getMenuItems();
  const msgId = cb.message?.message_id;
  if (!msgId) return;
  await editMessageText(
    chatId,
    msgId,
    "Наличие позиций (тап — переключить):",
    { reply_markup: stopKeyboard(items) }
  );
}

async function handleAdmStatus(
  chatId: number,
  cb: TgCallbackQueryT,
  orderId: string | undefined,
  status: string | undefined
): Promise<void> {
  if (!orderId || !status) return;
  if (
    status !== "in_progress" &&
    status !== "delivered" &&
    status !== "cancelled"
  ) {
    return;
  }
  const handler = cb.from.username ?? null;
  await updateOrderStatus(orderId, status as OrderStatus, handler ?? undefined);
  const updated = await getOrderById(orderId);
  if (!updated) return;
  // Убеждаемся, что admin_message_id есть (карточка редактируется на месте).
  if (!updated.admin_message_id && cb.message?.message_id) {
    updated.admin_message_id = cb.message.message_id;
  }
  await editOrderCard(chatId, updated);
}
