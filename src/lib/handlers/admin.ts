/**
 * Admin-поток (сообщения/callback из рабочей группы с chat.id == admin_chat_id).
 *
 * Команды:
 *   /init   — привязать текущий чат как admin_chat_id.
 *   /панель — панель управления (остатки, статистика).
 *   /стоп   — алиас /панель, открывает сразу редактор остатков.
 *   /стат   — дневная сводка (Europe/Moscow).
 *
 * Callback:
 *   adm_panel:<section>              — навигация панели
 *   adm_stk:<slug>:<inc|dec>         — изменить остаток
 *   adm_avail:<slug>                 — toggle доступности (ручной стоп/старт)
 *   adm_stop:<slug>                  — backward compat, алиас adm_avail
 *   adm_status:<order_uuid>:<status> — сменить статус заказа
 */

import type { TgUpdateT, TgCallbackQueryT, TgMessageT } from "@/lib/schemas";
import { CallbackData } from "@/lib/schemas";
import { answerCallbackQuery, sendMessage } from "@/lib/telegram/api";
import { supabase } from "@/lib/supabase/client";
import {
  getDailyStats,
  getOrderById,
  releaseReserved,
  returnReserved,
  setAdminChatId,
  updateOrderStatusGuarded,
} from "@/lib/supabase/queries";
import type { OrderStatus, PaymentMethod } from "@/types/database";
import { formatRub } from "./format";
import { editOrderCard } from "./admin_card";
import {
  handleAdmAvailCb,
  handleAdmPanelCb,
  handleAdmStkCb,
  openAdminPanel,
  openStockEditor,
} from "./adminPanel";

// ============================================================================
// Точка входа
// ============================================================================

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

  if (text === "/init") {
    await handleInit(msg, adminChatId);
    return;
  }

  if (adminChatId === null || BigInt(chatId) !== adminChatId) {
    return;
  }

  if (text === "/панель") {
    try {
      await openAdminPanel(chatId);
    } catch (err) {
      console.error("admin_panel_failed", { err: String(err) });
      try { await sendMessage(chatId, "⚠️ Не удалось открыть панель."); } catch { /* ignore */ }
    }
    return;
  }

  if (text === "/стоп" || text === "/stop") {
    try {
      await openStockEditor(chatId);
    } catch (err) {
      console.error("admin_stop_failed", { err: String(err) });
      try { await sendMessage(chatId, "⚠️ Не удалось загрузить остатки."); } catch { /* ignore */ }
    }
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
    const { data: bindRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "admin_bound_by")
      .maybeSingle();
    const boundBy = bindRow?.value ? Number(bindRow.value) : null;

    if (adminChatId !== null && BigInt(chatId) === adminChatId) {
      await sendMessage(chatId, "✅ Этот чат уже рабочий.");
      return;
    }

    if (adminChatId !== null && boundBy !== null && boundBy !== fromId) {
      await sendMessage(chatId, "Чат уже привязан.");
      return;
    }

    await setAdminChatId(chatId);
    await supabase.from("app_settings").upsert(
      { key: "admin_bound_by", value: String(fromId) },
      { onConflict: "key" }
    );
    await sendMessage(chatId, "✅ Этот чат — рабочий.");
  } catch (err) {
    console.error("admin_init_failed", { chat_id: chatId, err: String(err) });
    try { await sendMessage(chatId, "⚠️ Не удалось привязать чат. Повторите."); } catch { /* ignore */ }
  }
}

// ============================================================================
// /стат: дневная сводка
// ============================================================================

async function handleStat(chatId: number): Promise<void> {
  try {
    const stats = await getDailyStats();
    const date = moscowDate();

    if (
      stats.count === 0 &&
      stats.waited_sold_out.length === 0 &&
      stats.wanted_not_carried.length === 0
    ) {
      await sendMessage(chatId, "Сегодня пока пусто.");
      return;
    }

    const lines: string[] = [`📊 <b>Сегодня (${date}):</b>`];
    lines.push(`Заказов: ${stats.count} · Выручка: ${formatRub(stats.total_kop)}`);

    const p = stats.by_payment;
    const pp: string[] = [];
    if (p.cash > 0) pp.push(`💵 нал: ${formatRub(p.cash)}`);
    if (p.sbp > 0) pp.push(`📱 СБП: ${formatRub(p.sbp)}`);
    if (p.terminal > 0) pp.push(`💳 терминал: ${formatRub(p.terminal)}`);
    if (pp.length > 0) lines.push(pp.join(" · "));

    if (stats.stock.length > 0) {
      lines.push("");
      lines.push(
        "📦 <b>Остатки:</b> " +
          stats.stock.map((it) => `${it.title} — ${it.stock_qty}`).join(" · ")
      );
    }

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

    if (stats.waited_sold_out.length > 0) {
      lines.push("");
      lines.push("⏳ <b>Ждали (кончилось):</b>");
      lines.push(
        stats.waited_sold_out
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.count}`)
          .join(" · ")
      );
    }

    if (stats.wanted_not_carried.length > 0) {
      lines.push("");
      lines.push("👀 <b>Хотели (не возим):</b>");
      lines.push(
        stats.wanted_not_carried
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.count}`)
          .join(" · ")
      );
    }

    await sendMessage(chatId, lines.join("\n"));
    void (0 as unknown as PaymentMethod);
  } catch (err) {
    console.error("admin_stat_failed", { err: String(err) });
    try { await sendMessage(chatId, "⚠️ Не удалось собрать сводку."); } catch { /* ignore */ }
  }
}

function moscowDate(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  return `${msk.getUTCDate()} ${months[msk.getUTCMonth()]}`;
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

  if (adminChatId === null || BigInt(chatId) !== adminChatId) {
    return;
  }

  const raw = cb.data ?? "";
  const parsed = CallbackData.safeParse(raw);
  if (!parsed.success) return;
  const parts = raw.split(":");
  const action = parts[0];
  const arg1 = parts[1];
  const arg2 = parts[2];

  try {
    switch (action) {
      case "adm_panel":
        await handleAdmPanelCb(chatId, cb, arg1);
        return;
      case "adm_stk":
        await handleAdmStkCb(chatId, cb, arg1, arg2);
        return;
      case "adm_avail":
        await handleAdmAvailCb(chatId, cb, arg1);
        return;
      case "adm_stop":
        // Backward compat: old messages still have adm_stop: buttons
        await handleAdmAvailCb(chatId, cb, arg1);
        return;
      case "adm_status":
        await handleAdmStatus(chatId, cb, arg1, arg2);
        return;
    }
  } catch (err) {
    console.error("admin_callback_failed", { action, err: String(err) });
  }
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

  const handler = cb.from.username ?? undefined;
  const { updated } = await updateOrderStatusGuarded(
    orderId,
    status as OrderStatus,
    handler
  );

  if (!updated) {
    await answerCallbackQuery(cb.id, "Заказ уже обработан");
    return;
  }

  const order = await getOrderById(orderId);
  if (!order) return;

  // Release or return reserved stock
  if (status === "delivered") {
    try {
      await releaseReserved(order.items);
    } catch (err) {
      console.error("release_reserved_failed", { order_id: orderId, err: String(err) });
    }
  } else if (status === "cancelled") {
    try {
      await returnReserved(order.items);
    } catch (err) {
      console.error("return_reserved_failed", { order_id: orderId, err: String(err) });
    }
    // Notify the client — 403 (bot blocked) is expected and non-fatal
    try {
      await sendMessage(
        order.user_id,
        `❌ Заказ #${order.order_number} отменён.\n` +
          `Если это ошибка или передумали — оформите заново: жмите «Меню» 🐾`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]],
          },
        }
      );
    } catch (notifyErr) {
      console.warn("cancel_notify_failed", {
        order_id: orderId,
        user_id: order.user_id,
        err: String(notifyErr),
      });
    }
  }

  if (!order.admin_message_id && cb.message?.message_id) {
    order.admin_message_id = cb.message.message_id;
  }
  await editOrderCard(chatId, order);
}
