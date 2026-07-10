/**
 * Сборка inline-клавиатур бота.
 *
 * Все callback_data подчиняются регексу из schemas.ts:
 *   ^[a-z_]+(:[a-zA-Z0-9_\-]+){0,2}$
 * Лимит Telegram — 64 байта. Slug'и позиций короткие (см. миграцию).
 */

import type { CartItem, MenuItemRow, OrderStatus } from "@/types/database";
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
} from "@/lib/telegram/api";

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
        [{ text: "Без сиропа", callback_data: `var:${slug}:s_none` }],
        [
          { text: "Солёная карамель", callback_data: `var:${slug}:s_caramel` },
          { text: "Кокос", callback_data: `var:${slug}:s_coconut` },
          { text: "Ваниль", callback_data: `var:${slug}:s_vanilla` },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "🍈 Зелёный с гуавой", callback_data: `var:${slug}:tea_green` },
        { text: "🍑 Чёрный с абрикосом", callback_data: `var:${slug}:tea_black` },
      ],
    ],
  };
}

// ============================================================================
// Нижние панели (ReplyKeyboard)
// ============================================================================

/** Постоянная панель клиента. Шлётся один раз при /start. */
export function clientReplyKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: "🧋 Меню" }, { text: "🛒 Корзина" }],
      [{ text: "👀 Хочется попробовать" }, { text: "ℹ️ О нас" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** Постоянная панель админа. Шлётся при /init и после старта смены. */
export function adminReplyKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: "📊 Статистика" }, { text: "📦 Остатки" }],
      [{ text: "🔄 Новая смена" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// ============================================================================
// Корзина
// ============================================================================

/**
 * Клавиатура корзины. Строки: [−][N][+], где N — номер позиции (noop).
 * Центральная кнопка не несёт данных — нужна как визуальный разделитель.
 * confirmClear=true: кнопка «Очистить» становится «⚠️ Точно очистить?».
 */
export function cartKeyboard(
  cart: CartItem[],
  confirmClear = false
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  cart.forEach((_item, idx) => {
    rows.push([
      { text: "−", callback_data: `dec:${idx}` },
      { text: String(idx + 1), callback_data: "noop" },
      { text: "+", callback_data: `inc:${idx}` },
    ]);
  });

  rows.push([{ text: "✅ Оформить", callback_data: "checkout" }]);
  const clearBtn = confirmClear
    ? { text: "⚠️ Точно очистить?", callback_data: "cart_clear_go" }
    : { text: "🗑 Очистить", callback_data: "cart_clear" };
  rows.push([{ text: "➕ Добавить ещё", callback_data: "menu" }, clearBtn]);

  return { inline_keyboard: rows };
}

// ============================================================================
// Экран «Хочется попробовать»
// ============================================================================

export function wantListKeyboard(items: MenuItemRow[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = items.map((item) => {
    const suffix = item.available && item.stock === 0 ? " (кончилось)" : "";
    return [{ text: `${item.title}${suffix}`, callback_data: `want:${item.slug}` }];
  });
  rows.push([{ text: "⬅️ Меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

// ============================================================================
// Ориентир
// ============================================================================

export function landmarkKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🏁 У въезда", callback_data: "lm:entry" },
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
    inline_keyboard: [
      [
        { text: "👀 Спрос за всё время", callback_data: "adm_demand_all" },
        { text: "🔄 Новая смена", callback_data: "adm_shift_new" },
      ],
      [{ text: "⬅️ Назад", callback_data: "adm_panel:home" }],
    ],
  };
}

export function shiftConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Да, новая смена", callback_data: "adm_shift_go" },
        { text: "⬅️ Отмена", callback_data: "adm_panel:stats" },
      ],
    ],
  };
}

export function demandAllKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "adm_panel:stats" }]],
  };
}

/**
 * Редактор остатков: [−][N ✅/⛔][+] на каждую позицию.
 * Центральная кнопка (номер + статус) — toggle доступности.
 * Полный текст с названиями и остатками — в тексте сообщения.
 */
export function stockKeyboard(items: MenuItemRow[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  items.forEach((item, idx) => {
    const status = item.available ? "✅" : "⛔";
    rows.push([
      { text: "−", callback_data: `adm_stock:${item.slug}:dec` },
      { text: `${idx + 1} ${status}`, callback_data: `adm_stock:${item.slug}:toggle` },
      { text: "+", callback_data: `adm_stock:${item.slug}:inc` },
    ]);
  });

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
