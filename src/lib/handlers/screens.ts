/**
 * «Экраны» бота — отправка сообщений с текстами из SPEC.md, Блок 4.
 *
 * Каждая функция:
 *  1) собирает текст (через esc() для пользовательских полей),
 *  2) выбирает клавиатуру,
 *  3) вызывает sendMessage.
 *
 * Тексты — дословно по SPEC.md, менять их без правки спеки нельзя.
 */

import { sendMessage } from "@/lib/telegram/api";
import {
  aboutKeyboard,
  cartKeyboard,
  carKeyboard,
  confirmationKeyboard,
  landmarkKeyboard,
  mainMenuKeyboard,
  menuKeyboard,
  paymentKeyboard,
  variantKeyboard,
  wantConfirmKeyboard,
} from "@/lib/telegram/keyboards";
import type { CartItem, MenuItemRow, PaymentMethod } from "@/types/database";
import { esc } from "@/lib/telegram/escape";
import {
  cartTotalKop,
  cartTotalQty,
  formatRub,
  paymentLabel,
  renderBulletLines,
  renderCartLines,
} from "./format";

// ============================================================================
// URL из env (для about / confirmation)
// ============================================================================

function groupUrl(): string {
  return process.env.NEXT_PUBLIC_GROUP_URL ?? "https://t.me/";
}
function mapUrl(): string {
  return process.env.NEXT_PUBLIC_MAP_URL ?? "https://maps.google.com/";
}

// ============================================================================
// Приветствие / О нас / Меню
// ============================================================================

export async function sendWelcome(chatId: number): Promise<void> {
  const text =
    "🐱 <b>Bubble Cat</b> приехал к очереди!\n\n" +
    "Напитки и сэндвичи прямо к вашей машине — не выходя из очереди.\n" +
    "Соберите заказ, укажите машину, курьер принесёт. Оплата при получении.";
  await sendMessage(chatId, text, { reply_markup: mainMenuKeyboard() });
}

export async function sendAbout(chatId: number): Promise<void> {
  const text =
    "Bubble Cat — бабл-ти и сэндвичи 🐱\nМы на карте и в Telegram:";
  await sendMessage(chatId, text, {
    reply_markup: aboutKeyboard(mapUrl(), groupUrl()),
    disable_web_page_preview: true,
  });
}

export async function sendMenu(
  chatId: number,
  items: MenuItemRow[],
  cart: CartItem[]
): Promise<void> {
  const available = items.filter((i) => i.available);
  const unavailable = items.filter((i) => !i.available);
  const count = cartTotalQty(cart);

  let text: string;
  if (available.length === 0 && unavailable.length > 0) {
    text = "Сегодня всё разобрали 🙈, но вот что хотят другие:";
  } else {
    text = "🧋 Что берём? Всё по 500 мл.";
  }

  await sendMessage(chatId, text, {
    reply_markup: menuKeyboard(available, unavailable, count),
  });
}

// ============================================================================
// Выбор варианта
// ============================================================================

export async function sendVariantPrompt(
  chatId: number,
  item: MenuItemRow
): Promise<void> {
  if (item.variant_group === "syrup") {
    await sendMessage(
      chatId,
      `${esc(item.title)} — с сиропом или без? Сироп бесплатно 🙂`,
      { reply_markup: variantKeyboard(item.slug, "syrup") }
    );
    return;
  }
  if (item.variant_group === "tea") {
    await sendMessage(chatId, `${esc(item.title)} — какой?`, {
      reply_markup: variantKeyboard(item.slug, "tea"),
    });
    return;
  }
  // Не должно случиться (item без variant_group не должен попадать сюда).
}

// ============================================================================
// Корзина
// ============================================================================

export async function sendCart(chatId: number, cart: CartItem[]): Promise<void> {
  if (cart.length === 0) {
    await sendMessage(chatId, "🛒 Корзина пуста. Загляните в меню!", {
      reply_markup: {
        inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]],
      },
    });
    return;
  }
  const lines = renderCartLines(cart);
  const total = formatRub(cartTotalKop(cart));
  const text = `🛒 <b>Ваш заказ:</b>\n${lines}\n<b>Итого: ${total}</b>`;
  await sendMessage(chatId, text, { reply_markup: cartKeyboard(cart) });
}

// ============================================================================
// Оформление: шаги
// ============================================================================

export async function sendLandmarkPrompt(chatId: number): Promise<void> {
  await sendMessage(chatId, "Шаг 1/3. Где вы стоите в очереди?", {
    reply_markup: landmarkKeyboard(),
  });
}

export async function sendLandmarkTextPrompt(chatId: number): Promise<void> {
  await sendMessage(chatId, "Напишите ориентир одним сообщением.");
}

export async function sendCarPromptNew(chatId: number): Promise<void> {
  await sendMessage(
    chatId,
    "Шаг 2/3. Опишите машину одним сообщением: цвет, марку, номер.\n" +
      "Например: белая Гранта А123ВС"
  );
}

export async function sendCarPromptRepeat(
  chatId: number,
  lastCar: string
): Promise<void> {
  await sendMessage(chatId, `Шаг 2/3. Машина та же — ${esc(lastCar)}?`, {
    reply_markup: carKeyboard(),
  });
}

export async function sendPaymentPrompt(chatId: number): Promise<void> {
  await sendMessage(chatId, "Шаг 3/3. Как оплатите курьеру при получении?", {
    reply_markup: paymentKeyboard(),
  });
}

// ============================================================================
// Подтверждение клиенту
// ============================================================================

export async function sendOrderConfirmation(
  chatId: number,
  args: {
    orderNumber: number;
    cart: CartItem[];
    totalKop: number;
    payment: PaymentMethod;
    car: string;
    landmark: string;
  }
): Promise<void> {
  const bullets = renderBulletLines(args.cart);
  const total = formatRub(args.totalKop);
  const text =
    `✅ <b>Заказ #${args.orderNumber} принят!</b>\n` +
    `${bullets}\n` +
    `Итого: ${total} · ${paymentLabel(args.payment)}\n` +
    `🚗 ${esc(args.car)} · ${esc(args.landmark)}\n\n` +
    `Курьер подойдёт в течение 15–30 минут 🐾\n` +
    `Пока ждёте — загляните в нашу группу 🐱`;
  await sendMessage(chatId, text, {
    reply_markup: confirmationKeyboard(groupUrl()),
    disable_web_page_preview: true,
  });
}

// ============================================================================
// «Хочу 👀»
// ============================================================================

export async function sendWantAck(
  chatId: number,
  title: string
): Promise<void> {
  const text =
    `Записали! 🐾 Наберётся спрос — привезём.\n` +
    `Спасибо, что дали знать про «${esc(title)}» 🐱`;
  await sendMessage(chatId, text, {
    reply_markup: wantConfirmKeyboard(groupUrl()),
    disable_web_page_preview: true,
  });
}

/** Общая «мягкая подсказка» на непонятный текст. */
export async function sendSoftHint(chatId: number): Promise<void> {
  await sendMessage(
    chatId,
    "Не совсем понял 🐾 Загляните в меню — там всё, что можно заказать.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]],
      },
    }
  );
}

/** Ошибка «повторите». Не сбрасывает state. */
export async function sendError(chatId: number): Promise<void> {
  await sendMessage(
    chatId,
    "⚠️ Ой, что-то сломалось. Повторите, пожалуйста."
  );
}

// Общее ограничение по ссылкам в тексте подтверждения — превью выключаем.
// (реэкспорт нужен для admin-модуля)
export { groupUrl, mapUrl };

// Для admin-модуля пригодятся:
export { renderBulletLines, paymentLabel };
