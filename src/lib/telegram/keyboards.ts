/**
 * Сборка inline-клавиатур бота.
 *
 * Все callback_data подчиняются регексу из schemas.ts:
 *   ^[a-z_]+(:[a-zA-Z0-9_\-]+){0,2}$
 * Лимит Telegram — 64 байта. Slug'и позиций короткие (см. миграцию).
 *
 * Тексты кнопок и структура — по SPEC.md, Блок 4 (Диалоговые сценарии).
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

/**
 * Меню: секция «в наличии» + секция «сегодня нет 👀» + кнопка корзины.
 * @param available   позиции с available=true (field_item тоже true, отфильтровано выше)
 * @param unavailable позиции с available=false (тоже field_item=true в MVP; при желании
 *                    можно докидывать любые slug'и «сегодня нет»)
 * @param cartCount   сумма qty в корзине — для подписи «🛒 Мой заказ (N)»
 */
export function menuKeyboard(
  available: MenuItemRow[],
  unavailable: MenuItemRow[],
  cartCount: number
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
    // Заголовок-разделитель как кнопка-пустышка: Telegram требует callback_data,
    // поэтому кладём `menu` — тап просто перерендерит меню, не портит UX.
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
    cartCount > 0 ? `🛒 Мой заказ (${cartCount})` : "🛒 Мой заказ";
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
  // tea
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

/**
 * Клавиатура корзины: на каждую строку ряд [−][title ×qty][+], затем
 * [✅ Оформить] и [➕ Добавить ещё].
 */
export function cartKeyboard(cart: CartItem[]): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  cart.forEach((item, idx) => {
    // Название с вариантом, чтобы отличать «латте с сиропом» от «без».
    const label = item.variant
      ? `${item.title} (${item.variant.toLowerCase()}) ×${item.qty}`
      : `${item.title} ×${item.qty}`;
    rows.push([
      { text: "−", callback_data: `dec:${idx}` },
      // Центральная «кнопка» — визуальный ярлык. Тап на неё безопасен: показываем
      // ту же корзину (callback_data:cart).
      { text: label, callback_data: "cart" },
      { text: "+", callback_data: `inc:${idx}` },
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

/**
 * Клавиатура быстрого повтора машины. Показываем только если last_car есть.
 * Сам last_car в клавиатуру НЕ вставляем (может быть длинным); он идёт в текст
 * сообщения.
 */
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

/**
 * Кнопки под карточкой заказа в admin-чате. После delivered/cancelled клавиатуру
 * НЕ рисуем (при editMessageText передаём undefined в reply_markup, чтобы её убрать).
 */
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

/** Пустая клавиатура — чтобы при editMessageText убрать кнопки статуса. */
export function emptyKeyboard(): InlineKeyboardMarkup {
  return { inline_keyboard: [] };
}

/**
 * Клавиатура для admin-статуса, зависящая от текущего статуса. После
 * delivered/cancelled кнопок нет.
 */
export function keyboardForOrderStatus(
  orderId: string,
  status: OrderStatus
): InlineKeyboardMarkup {
  if (status === "delivered" || status === "cancelled") return emptyKeyboard();
  return orderAdminKeyboard(orderId);
}

// ============================================================================
// Admin: /стоп (наличие)
// ============================================================================

/**
 * Клавиатура наличия: одна кнопка на позицию, значок ✅ / ⛔ отражает
 * текущее `available`.
 */
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

/** Клавиатура для «хочу 👀» подтверждения — только ссылка на группу. */
export function wantConfirmKeyboard(groupUrl: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🐱 Наша группа", url: groupUrl }],
      [{ text: "⬅️ Меню", callback_data: "menu" }],
    ],
  };
}
