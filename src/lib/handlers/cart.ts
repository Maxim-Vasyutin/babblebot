/**
 * Операции над корзиной (пуре-функции). Живут отдельно от Bot API, чтобы их
 * можно было юнит-тестить без сети.
 *
 * Правила из SPEC.md, Блок 5 (Правила валидации):
 * - qty на позицию: 1..20. [+] выше 20 — блок, [−] ниже 1 — удалить строку.
 * - Строки с одинаковым slug+variant объединяются (растёт qty).
 * - Разный variant = разные строки.
 */

import type { CartItem, MenuItemRow } from "@/types/database";

export const MAX_QTY = 20;

/** Добавить позицию в корзину. Возвращает новый массив. */
export function addToCart(
  cart: CartItem[],
  item: MenuItemRow,
  variant: string | null
): { cart: CartItem[]; capped: boolean } {
  const idx = cart.findIndex(
    (it) => it.slug === item.slug && it.variant === variant
  );
  const next = cart.slice();
  if (idx >= 0) {
    const current = next[idx];
    if (current.qty >= MAX_QTY) {
      return { cart: next, capped: true };
    }
    next[idx] = { ...current, qty: current.qty + 1 };
    return { cart: next, capped: false };
  }
  next.push({
    slug: item.slug,
    title: item.title,
    variant,
    price_kop: item.price_kop,
    qty: 1,
  });
  return { cart: next, capped: false };
}

/** [+] на строке idx. Возвращает { cart, capped, notFound }. */
export function incCart(
  cart: CartItem[],
  idx: number
): { cart: CartItem[]; capped: boolean; notFound: boolean } {
  if (idx < 0 || idx >= cart.length) {
    return { cart, capped: false, notFound: true };
  }
  const current = cart[idx];
  if (current.qty >= MAX_QTY) {
    return { cart, capped: true, notFound: false };
  }
  const next = cart.slice();
  next[idx] = { ...current, qty: current.qty + 1 };
  return { cart: next, capped: false, notFound: false };
}

/** [−] на строке idx: qty=1 удаляет строку. */
export function decCart(
  cart: CartItem[],
  idx: number
): { cart: CartItem[]; removed: boolean; notFound: boolean } {
  if (idx < 0 || idx >= cart.length) {
    return { cart, removed: false, notFound: true };
  }
  const current = cart[idx];
  const next = cart.slice();
  if (current.qty <= 1) {
    next.splice(idx, 1);
    return { cart: next, removed: true, notFound: false };
  }
  next[idx] = { ...current, qty: current.qty - 1 };
  return { cart: next, removed: false, notFound: false };
}

/**
 * Отфильтровать корзину по актуальному наличию (для checkout, edge case #5).
 * Возвращает { cart, dropped } — dropped — список названий убранных позиций.
 */
export function filterAvailable(
  cart: CartItem[],
  items: MenuItemRow[]
): { cart: CartItem[]; dropped: string[] } {
  const availableSlugs = new Set(
    items.filter((i) => i.available && i.stock_qty > 0).map((i) => i.slug)
  );
  const kept: CartItem[] = [];
  const dropped: string[] = [];
  for (const it of cart) {
    if (availableSlugs.has(it.slug)) kept.push(it);
    else dropped.push(it.title);
  }
  return { cart: kept, dropped };
}

/** Обрезать текст до N символов; сообщить если резали. */
export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  const trimmed = s.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, max), truncated: true };
}
