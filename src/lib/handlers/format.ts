/**
 * Форматирование строк и сумм для клиентских / admin-сообщений.
 *
 * - Деньги: INTEGER копейки → «250₽» (делим на 100, без плавающей точки).
 * - Время: HH:MM в Europe/Moscow — для карточек и подтверждений.
 * - Ярлыки способа оплаты: «💵 наличные», «📱 СБП», «💳 терминал».
 * - Ярлыки ориентира: «у въезда», «середина очереди», «хвост очереди».
 */

import type { CartItem, PaymentMethod } from "@/types/database";
import { esc } from "@/lib/telegram/escape";

/** Копейки → «250₽» (integer-математика). */
export function formatRub(kop: number): string {
  return `${Math.round(kop / 100)}₽`;
}

/** Сумма корзины в копейках. */
export function cartTotalKop(cart: CartItem[]): number {
  return cart.reduce((sum, it) => sum + it.price_kop * it.qty, 0);
}

/** Общее число позиций в корзине (для подписи кнопки). */
export function cartTotalQty(cart: CartItem[]): number {
  return cart.reduce((sum, it) => sum + it.qty, 0);
}

/** HH:MM в Europe/Moscow (без DST). */
export function moscowHhMm(d: Date = new Date()): string {
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  const hh = String(msk.getUTCHours()).padStart(2, "0");
  const mm = String(msk.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Ярлык способа оплаты (короткий, для карточки/подтверждения). */
export function paymentLabel(m: PaymentMethod): string {
  switch (m) {
    case "sbp":
      return "📱 СБП";
    case "cash":
      return "💵 наличные";
    case "terminal":
      return "💳 терминал";
  }
}

/** Код кнопки ориентира → человекочитаемое имя. */
export function landmarkLabel(code: "entry" | "middle" | "tail"): string {
  switch (code) {
    case "entry":
      return "у въезда";
    case "middle":
      return "середина очереди";
    case "tail":
      return "хвост очереди";
  }
}

/**
 * Список строк корзины в тексте: «1. Айс-латте (с сиропом) ×2 — 500₽».
 * variant в скобках нижним регистром для читабельности.
 */
export function renderCartLines(cart: CartItem[]): string {
  return cart
    .map((it, idx) => {
      const name = it.variant
        ? `${esc(it.title)} (${esc(it.variant.toLowerCase())})`
        : esc(it.title);
      const sum = formatRub(it.price_kop * it.qty);
      return `${idx + 1}. ${name} ×${it.qty} — ${sum}`;
    })
    .join("\n");
}

/**
 * Список строк для карточки/подтверждения (без индексов и без суммы).
 * «• Айс-латте (с сиропом) ×2»
 */
export function renderBulletLines(cart: CartItem[]): string {
  return cart
    .map((it) => {
      const name = it.variant
        ? `${esc(it.title)} (${esc(it.variant.toLowerCase())})`
        : esc(it.title);
      return `• ${name} ×${it.qty}`;
    })
    .join("\n");
}

/**
 * Ярлык пользователя для карточки в admin-чате. Если username есть — @username,
 * иначе — «id 555000111» (Блок 6, edge case #10).
 */
export function userTag(username: string | null, userId: number): string {
  if (username && username.length > 0) return `@${esc(username)}`;
  return `id ${userId}`;
}
