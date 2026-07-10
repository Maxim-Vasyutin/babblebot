/**
 * Admin-панель управления: редактор остатков, смены, статистика.
 *
 * /панель → присылает новое сообщение с кнопками [📦 Остатки] [📊 Статистика].
 * Все последующие переходы редактируют ту же карточку на месте.
 */

import { editMessageText, sendMessage, answerCallbackQuery } from "@/lib/telegram/api";
import {
  getAllTimeDemand,
  getCurrentShift,
  getMenuItems,
  getShiftAgeHours,
  getShiftStats,
  startShift,
  toggleAvailability,
  updateStockQty,
} from "@/lib/supabase/queries";
import {
  adminPanelKeyboard,
  demandAllKeyboard,
  panelStatsKeyboard,
  shiftConfirmKeyboard,
  stockKeyboard,
} from "@/lib/telegram/keyboards";
import type { TgCallbackQueryT } from "@/lib/schemas";
import { formatRub } from "./format";

// ============================================================================
// Утилита: дата МСК
// ============================================================================

function moscowDateFromIso(iso: string): string {
  const msk = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const hh = String(msk.getUTCHours()).padStart(2, "0");
  const mm = String(msk.getUTCMinutes()).padStart(2, "0");
  return `${msk.getUTCDate()} ${months[msk.getUTCMonth()]}, ${hh}:${mm}`;
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
  const [items, shift] = await Promise.all([getMenuItems(), getCurrentShift()]);
  const shiftDate = shift ? moscowDateFromIso(shift.started_at) : "нет смены";
  const text =
    `📦 <b>Остатки</b> · смена от ${shiftDate}\n` +
    "[+]/[−] — остаток · центральная кнопка — стоп/старт";
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: stockKeyboard(items) });
  } else {
    await sendMessage(chatId, text, { reply_markup: stockKeyboard(items) });
  }
}

async function renderStats(chatId: number, msgId?: number): Promise<void> {
  const shift = await getCurrentShift();

  if (!shift) {
    const text = "⚠️ <b>Нет открытой смены.</b>\nНажмите «Новая смена» чтобы начать.";
    const kb = {
      inline_keyboard: [
        [{ text: "🔄 Новая смена", callback_data: "adm_shift_new" }],
        [{ text: "⬅️ Назад", callback_data: "adm_panel:home" }],
      ],
    };
    if (msgId) {
      await editMessageText(chatId, msgId, text, { reply_markup: kb });
    } else {
      await sendMessage(chatId, text, { reply_markup: kb });
    }
    return;
  }

  const stats = await getShiftStats(shift.id);
  const shiftDate = moscowDateFromIso(shift.started_at);
  const ageHours = getShiftAgeHours(shift);
  const ageLabel =
    ageHours < 1
      ? "меньше часа"
      : `${Math.floor(ageHours)} ч`;

  const lines: string[] = [];

  if (ageHours > 16) {
    lines.push("⚠️ <b>Смена не закрыта, цифры могут врать</b>");
    lines.push("");
  }

  lines.push(`📊 <b>Смена от ${shiftDate} (идёт ${ageLabel}):</b>`);

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
        stats.stock.map((it) => `${it.title} — ${it.stock}`).join(" · ")
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

async function renderShiftConfirm(chatId: number, msgId?: number): Promise<void> {
  const shift = await getCurrentShift();
  let text: string;
  if (shift) {
    const ageHours = getShiftAgeHours(shift);
    const shiftDate = moscowDateFromIso(shift.started_at);
    const ageLabel =
      ageHours < 1 ? "меньше часа" : `${Math.floor(ageHours)} ч`;
    text =
      `🔄 <b>Новая смена</b>\n\n` +
      `Текущая смена открыта ${shiftDate} (${ageLabel} назад).\n` +
      `Закрыть её и начать новую? Остатки вернутся к 5 шт на позицию.`;
  } else {
    text = "🔄 <b>Новая смена</b>\n\nОткрытых смен нет. Начать новую?";
  }
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: shiftConfirmKeyboard() });
  } else {
    await sendMessage(chatId, text, { reply_markup: shiftConfirmKeyboard() });
  }
}

async function renderDemandAll(chatId: number, msgId?: number): Promise<void> {
  const all = await getAllTimeDemand();

  const lines: string[] = ["👀 <b>Спрос за всё время</b>", ""];

  const soldOut = all.filter((e) => e.reason === "sold_out");
  const unavailable = all.filter((e) => e.reason === "unavailable");

  if (soldOut.length === 0 && unavailable.length === 0) {
    lines.push("Пока никто ничего не ждал.");
  }

  if (soldOut.length > 0) {
    lines.push("⏳ <b>Ждали (кончилось):</b>");
    for (const e of soldOut.slice(0, 10)) {
      lines.push(`${e.title} — ${e.count}`);
    }
  }

  if (unavailable.length > 0) {
    if (soldOut.length > 0) lines.push("");
    lines.push("👀 <b>Хотели (не возим):</b>");
    for (const e of unavailable.slice(0, 10)) {
      lines.push(`${e.title} — ${e.count}`);
    }
  }

  const text = lines.join("\n");
  if (msgId) {
    await editMessageText(chatId, msgId, text, { reply_markup: demandAllKeyboard() });
  } else {
    await sendMessage(chatId, text, { reply_markup: demandAllKeyboard() });
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

/** adm_stock:<slug>:inc/dec/toggle — изменить остаток или доступность, перерисовать. */
export async function handleAdmStockCb(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined,
  op: string | undefined
): Promise<void> {
  if (!slug || !op) return;
  const msgId = cb.message?.message_id;

  if (op === "inc" || op === "dec") {
    const delta = op === "inc" ? 1 : -1;
    const { clamped } = await updateStockQty(slug, delta);
    if (clamped) {
      await answerCallbackQuery(cb.id, "Уже ноль");
    }
  } else if (op === "toggle") {
    await toggleAvailability(slug);
  } else {
    return;
  }

  await renderStock(chatId, msgId);
}

/** adm_stk:<slug>:inc/dec — backward compat alias. */
export async function handleAdmStkCb(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined,
  op: string | undefined
): Promise<void> {
  return handleAdmStockCb(chatId, cb, slug, op);
}

/** adm_avail:<slug> — backward compat alias для toggle доступности. */
export async function handleAdmAvailCb(
  chatId: number,
  cb: TgCallbackQueryT,
  slug: string | undefined
): Promise<void> {
  return handleAdmStockCb(chatId, cb, slug, "toggle");
}

/** adm_shift_new — показать экран подтверждения смены. */
export async function handleAdmShiftNewCb(
  chatId: number,
  cb: TgCallbackQueryT
): Promise<void> {
  await renderShiftConfirm(chatId, cb.message?.message_id);
}

/** adm_shift_go — подтверждено, открыть новую смену. */
export async function handleAdmShiftGoCb(
  chatId: number,
  cb: TgCallbackQueryT
): Promise<void> {
  const handler = cb.from.username ?? `id${cb.from.id}`;
  try {
    await startShift(handler);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Уникальный индекс сработал — смена уже начата (Edge Case 4)
    if (msg.includes("unique") || msg.includes("idx_shifts_single_open")) {
      await answerCallbackQuery(cb.id, "Смена уже начата");
      return;
    }
    throw err;
  }
  await renderStock(chatId, cb.message?.message_id);
}

/** adm_demand_all — спрос за всё время. */
export async function handleAdmDemandAllCb(
  chatId: number,
  cb: TgCallbackQueryT
): Promise<void> {
  await renderDemandAll(chatId, cb.message?.message_id);
}
