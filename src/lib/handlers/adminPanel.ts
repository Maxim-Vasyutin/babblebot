/**
 * Admin-панель управления: редактор остатков, навигация.
 *
 * /панель → присылает новое сообщение с кнопками [📦 Остатки] [📊 Статистика].
 * Все последующие переходы (adm_panel:*, adm_stk:*, adm_avail:*) редактируют
 * ту же карточку на месте — чат не захламляется.
 */

import { editMessageText, sendMessage, answerCallbackQuery } from "@/lib/telegram/api";
import {
  getDailyStats,
  getMenuItems,
  toggleAvailability,
  updateStockQty,
} from "@/lib/supabase/queries";
import {
  adminPanelKeyboard,
  panelStatsKeyboard,
  stockKeyboard,
} from "@/lib/telegram/keyboards";
import type { TgCallbackQueryT } from "@/lib/schemas";
import { formatRub } from "./format";

// ============================================================================
// Утилита: дата МСК
// ============================================================================

function moscowDate(): string {
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  return `${msk.getUTCDate()} ${months[msk.getUTCMonth()]}`;
}

// ============================================================================
// Рендеры экранов
// ============================================================================

async function renderHome(chatId: number, msgId?: number): Promise<void> {
  const text = "🐱 <b>Панель Queue Cat</b>";
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: adminPanelKeyboard() });
  } else {
    await sendMessage(chatId, text, { reply_markup: adminPanelKeyboard() });
  }
}

async function renderStock(chatId: number, msgId?: number): Promise<void> {
  const items = await getMenuItems();
  const text =
    "📦 <b>Остатки</b>\n" +
    "[+]/[−] — изменить остаток · центральная кнопка — стоп/старт";
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: stockKeyboard(items) });
  } else {
    await sendMessage(chatId, text, { reply_markup: stockKeyboard(items) });
  }
}

async function renderStats(chatId: number, msgId?: number): Promise<void> {
  const stats = await getDailyStats();
  const date = moscowDate();
  const lines: string[] = [`📊 <b>Сегодня (${date}):</b>`];

  if (stats.count === 0) {
    lines.push("Заказов пока нет.");
  } else {
    lines.push(`Заказов: ${stats.count} · Выручка: ${formatRub(stats.total_kop)}`);
    const p = stats.by_payment;
    const pp: string[] = [];
    if (p.cash > 0) pp.push(`💵 нал: ${formatRub(p.cash)}`);
    if (p.sbp > 0) pp.push(`📱 СБП: ${formatRub(p.sbp)}`);
    if (p.terminal > 0) pp.push(`💳 терминал: ${formatRub(p.terminal)}`);
    if (pp.length > 0) lines.push(pp.join(" · "));

    if (stats.top_items.length > 0) {
      lines.push("");
      lines.push(
        "🔥 <b>Заказывали:</b> " +
          stats.top_items
            .slice(0, 5)
            .map((it) => `${it.title} — ${it.qty}`)
            .join(" · ")
      );
    }
  }

  if (stats.stock.length > 0) {
    lines.push("");
    lines.push(
      "📦 <b>Остатки:</b> " +
        stats.stock.map((it) => `${it.title} — ${it.stock_qty}`).join(" · ")
    );
  }

  if (stats.waited_sold_out.length > 0) {
    lines.push("");
    lines.push(
      "⏳ <b>Ждали (кончилось):</b> " +
        stats.waited_sold_out
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.count}`)
          .join(" · ")
    );
  }

  if (stats.wanted_not_carried.length > 0) {
    lines.push("");
    lines.push(
      "👀 <b>Хотели (не возим):</b> " +
        stats.wanted_not_carried
          .slice(0, 5)
          .map((it) => `${it.title} — ${it.count}`)
          .join(" · ")
    );
  }

  const text = lines.join("\n");
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: panelStatsKeyboard() });
  } else {
    await sendMessage(chatId, text, { reply_markup: panelStatsKeyboard() });
  }
}

// ============================================================================
// Точки входа из admin.ts
// ============================================================================

/** /панель — открыть панель (новое сообщение). */
export async function openAdminPanel(chatId: number): Promise<void> {
  await renderHome(chatId, undefined);
}

/** /стоп — открыть сразу редактор остатков (новое сообщение). */
export async function openStockEditor(chatId: number): Promise<void> {
  await renderStock(chatId, undefined);
}

/** adm_panel:home/stock/stats — переключить экран (edit на месте). */
export async function handleAdmPanelCb(
  chatId: number,
  cb: TgCallbackQueryT,
  section: string | undefined
): Promise<void> {
  const msgId = cb.message?.message_id;
  switch (section) {
    case "home":
      await renderHome(chatId, msgId);
      break;
    case "stock":
      await renderStock(chatId, msgId);
      break;
    case "stats":
      await renderStats(chatId, msgId);
      break;
  }
}

/** adm_stk:<slug>:inc/dec — изменить остаток, перерисовать редактор. */
export async function handleAdmStkCb(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined,
  op: string | undefined
): Promise<void> {
  if (!slug || (op !== "inc" && op !== "dec")) return;
  const delta = op === "inc" ? 1 : -1;
  const { clamped } = await updateStockQty(slug, delta);
  if (clamped) {
    await answerCallbackQuery(cb.id, "Уже ноль");
  }
  const msgId = cb.message?.message_id;
  await renderStock(chatId, msgId);
}

/** adm_avail:<slug> — переключить доступность (✅/⛔), перерисовать редактор. */
export async function handleAdmAvailCb(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined
): Promise<void> {
  if (!slug) return;
  await toggleAvailability(slug);
  const msgId = cb.message?.message_id;
  await renderStock(chatId, msgId);
}
