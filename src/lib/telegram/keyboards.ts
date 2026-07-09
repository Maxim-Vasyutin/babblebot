/**
 * Сборка inline-клавиатур бота.
 *
 * Все callback_data подчиняются регексу из schemas.ts:
 *   ^[a-z_]+(:[a-zA-Z0-9_\-]+){0,2}$
 * Лимит Telegram — 64 байта. Slug'и позиций короткие (см. миграцию).
 */

import type { CartItem, MenuItemRow, OrderStatus } from "@/types/database";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@/lib/telegram/api";

// ============================================================================
// Приветствие / главное меню
// ============================================================================

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🧋 Меню", callback_data: "menu" }],
      [
        { text: "🛒 Мой заказ", callback_data: "cart" },
        { text: "ℹ️ О нас", callback_data: "about" },
      ],
    ],
  };
}

// ============================================================================
// Меню
// ============================================================================

export function menuKeyboard(
  available: MenuItemRow[],
  unavailable: MenuItemRow[],
  cartCount: number,
  cartKop: number = 0
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  for (const item of available) {
    const price = Math.round(item.price_kop / 100);
    rows.push([
      {
        text: `${item.title} — ${price}₽`,
        callback_data: `item:${item.slug}`,
      },
    ]);
  }

  if (unavailable.length > 0) {
    rows.push([{ text: "👀 Сегодня нет — жми, если хотел бы:", callback_data: "menu" }]);
    for (const item of unavailable) {
      rows.push([
        {
          text: `${item.title} 👀`,
          callback_data: `want:${item.slug}`,
        },
      ]);
    }
  }

  const cartLabel =
    cartCount > 0
      ? `🛒 Корзина (${cartCount}) · ${Math.round(cartKop / 100)}₽`
      : "🛒 Корзина";
  rows.push([{ text: cartLabel, callback_data: "cart" }]);

  return { inline_keyboard: rows };
}

// ============================================================================
// Выбор варианта
// ============================================================================

export function variantKeyboard(
  slug: string,
  variantGroup: "syrup" | "tea"
): InlineKeyboardMarkup {
  if (variantGroup === "syrup") {
    return {
      inline_keyboard: [
        [
          { text: "Без сиропа", callback_data: `var:${slug}:syrup_no` },
          { text: "С сиропом", callback_data: `var:${slug}:syrup_yes` },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "Зелёный", callback_data: `var:${slug}:tea_green` },
        { text: "Чёрный", callback_data: `var:${slug}:tea_black` },
      ],
    ],
  };
}

// ============================================================================
// Корзина
// ============================================================================

export function cartKeyboard(cart: CartItem[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  cart.forEach((item, idx) => {
    const label = item.variant
      ? `${item.title} (${item.variant.toLowerCase()}) ×${item.qty}`
      : `${item.title} ×${item.qty}`;
    rows.push([
      { text: "−", callback_data: `dec:${idx}` },
      { text: label, callback_data: "cart" },
      { text: "+", callback_data: `inc:${idx}` },
      { text: "✖", callback_data: `del:${idx}` },
    ]);
  });

  rows.push([{ text: "✅ Оформить", callback_data: "checkout" }]);
  rows.push([{ text: "➕ Добавить ещё", callback_data: "menu" }]);

  return { inline_keyboard: rows };
}

// ============================================================================
// Ориентир
// ============================================================================

export function landmarkKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🚩 У въезда", callback_data: "lm:entry" },
        { text: "🚗 Середина", callback_data: "lm:middle" },
      ],
      [
        { text: "🐢 Хвост", callback_data: "lm:tail" },
        { text: "📍 Напишу словами", callback_data: "lm:text" },
      ],
    ],
  };
}

// ============================================================================
// Машина
// ============================================================================

export function carKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Да, та же", callback_data: "car_same" },
        { text: "✏️ Другая", callback_data: "car_new" },
      ],
    ],
  };
}

// ============================================================================
// Оплата
// ============================================================================

export function paymentKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📱 СБП", callback_data: "pay:sbp" },
        { text: "💵 Наличные", callback_data: "pay:cash" },
        { text: "💳 Терминал", callback_data: "pay:terminal" },
      ],
    ],
  };
}

// ============================================================================
// Admin: карточка заказа
// ============================================================================

export function orderAdminKeyboard(orderId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🚚 Взял", callback_data: `adm_status:${orderId}:in_progress` },
        { text: "✅ Доставлен", callback_data: `adm_status:${orderId}:delivered` },
      ],
      [{ text: "❌ Отмена", callback_data: `adm_status:${orderId}:cancelled` }],
    ],
  };
}

export function emptyKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [] };
}

export function keyboardForOrderStatus(
  orderId: string,
  status: OrderStatus
): InlineKeyboardMarkup {
  if (status === "delivered" || status === "cancelled") return emptyKeyboard();
  return orderAdminKeyboard(orderId);
}

// ============================================================================
// Admin: панель управления
// ============================================================================

export function adminPanelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📦 Остатки", callback_data: "adm_panel:stock" },
        { text: "📊 Статистика", callback_data: "adm_panel:stats" },
      ],
    ],
  };
}

export function panelStatsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "adm_panel:home" }]],
  };
}

/**
 * Редактор остатков: одна строка на полевую позицию.
 * [−] [Айс-латте · 5 (🚚 2) ✅] [+]
 * Центральная кнопка — toggle доступности (adm_avail:<slug>).
 */
export function stockKeyboard(items: MenuItemRow[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  for (const item of items) {
    const status = item.available ? "✅" : "⛔";
    const label = `${item.title} · ${item.stock_qty} (🚚 ${item.reserved_qty}) ${status}`;
    rows.push([
      { text: "−", callback_data: `adm_stk:${item.slug}:dec` },
      { text: label, callback_data: `adm_avail:${item.slug}` },
      { text: "+", callback_data: `adm_stk:${item.slug}:inc` },
    ]);
  }

  rows.push([{ text: "⬅️ Назад", callback_data: "adm_panel:home" }]);
  return { inline_keyboard: rows };
}

// ============================================================================
// Admin: /стоп (устаревший, оставлен для backward compat)
// ============================================================================

export function stopKeyboard(items: MenuItemRow[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: items.map((it) => [
      {
        text: `${it.title} ${it.available ? "✅" : "⛔"}`,
        callback_data: `adm_stop:${it.slug}`,
      },
    ]),
  };
}

// ============================================================================
// «О нас» и подтверждение заказа
// ============================================================================

export function aboutKeyboard(
  mapUrl: string,
  groupUrl: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📍 На карте", url: mapUrl },
        { text: "🐱 Telegram-группа", url: groupUrl },
      ],
      [{ text: "⬅️ Меню", callback_data: "menu" }],
    ],
  };
}

export function confirmationKeyboard(groupUrl: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🐱 Наша группа", url: groupUrl },
        { text: "🧋 Заказать ещё", callback_data: "menu" },
      ],
    ],
  };
}

export function wantConfirmKeyboard(groupUrl: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🐱 Наша группа", url: groupUrl }],
      [{ text: "⬅️ Меню", callback_data: "menu" }],
    ],
  };
}
