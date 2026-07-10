/**
 * «Экраны» бота — тексты и клавиатуры из SPEC.md, Блок 4.
 *
 * build* функции возвращают {text, options} для renderScreen.
 * send* функции — тонкие обёртки для прямых отправок (чек заказа, ошибки, ack).
 */

import { sendMessage } from "@/lib/telegram/api";
import type { SendMessageOptions } from "@/lib/telegram/api";
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

export type ScreenPayload = { text: string; options: SendMessageOptions };

// ============================================================================
// URL из env
// ============================================================================

function groupUrl(): string {
  return process.env.NEXT_PUBLIC_GROUP_URL ?? "https://t.me/";
}
function mapUrl(): string {
  return process.env.NEXT_PUBLIC_MAP_URL ?? "https://maps.google.com/";
}

// ============================================================================
// build* — возвращают {text, options} для renderScreen
// ============================================================================

export function buildWelcome(): ScreenPayload {
  return {
    text:
      "🐱 <b>Bubble Cat</b> приехал к очереди!\n\n" +
      "Напитки и сэндвичи прямо к вашей машине — не выходя из очереди.\n" +
      "Соберите заказ, укажите машину, курьер принесёт. Оплата при получении.",
    options: { reply_markup: mainMenuKeyboard() },
  };
}

export function buildAbout(): ScreenPayload {
  return {
    text: "Bubble Cat — бабл-ти и сэндвичи 🐱\nМы на карте и в Telegram:",
    options: {
      reply_markup: aboutKeyboard(mapUrl(), groupUrl()),
      disable_web_page_preview: true,
    },
  };
}

export function buildMenu(items: MenuItemRow[], cart: CartItem[]): ScreenPayload {
  const available = items.filter((i) => i.available && i.stock > 0);
  const unavailable = items.filter((i) => !i.available || i.stock === 0);
  const count = cartTotalQty(cart);
  const totalKop = cartTotalKop(cart);

  const text =
    available.length === 0 && unavailable.length > 0
      ? "Сегодня всё разобрали 🙈, но вот что хотят другие:"
      : "🧋 Что берём? Всё по 500 мл.";

  return {
    text,
    options: { reply_markup: menuKeyboard(available, unavailable, count, totalKop) },
  };
}

export function buildVariantPrompt(item: MenuItemRow): ScreenPayload | null {
  if (item.variant_group === "syrup") {
    return {
      text: `${esc(item.title)} — какой сироп? Сироп бесплатно 🙂`,
      options: { reply_markup: variantKeyboard(item.slug, "syrup") },
    };
  }
  if (item.variant_group === "tea") {
    return {
      text: `${esc(item.title)} — какой?`,
      options: { reply_markup: variantKeyboard(item.slug, "tea") },
    };
  }
  return null;
}

export function buildCart(cart: CartItem[]): ScreenPayload {
  if (cart.length === 0) {
    return {
      text: "🛒 Корзина пуста. Загляните в меню!",
      options: {
        reply_markup: { inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]] },
      },
    };
  }
  const lines = renderCartLines(cart);
  const total = formatRub(cartTotalKop(cart));
  return {
    text: `🛒 <b>Ваш заказ:</b>\n${lines}\n<b>Итого: ${total}</b>`,
    options: { reply_markup: cartKeyboard(cart) },
  };
}

export function buildLandmarkPrompt(): ScreenPayload {
  return {
    text: "Шаг 1/3. Где вы стоите в очереди?",
    options: { reply_markup: landmarkKeyboard() },
  };
}

export function buildLandmarkTextPrompt(): ScreenPayload {
  return { text: "Напишите ориентир одним сообщением.", options: {} };
}

export function buildCarPromptNew(): ScreenPayload {
  return {
    text:
      "Шаг 2/3. Опишите машину одним сообщением: цвет, марку, номер.\n" +
      "Например: белая Гранта А123ВС",
    options: {},
  };
}

export function buildCarPromptRepeat(lastCar: string): ScreenPayload {
  return {
    text: `Шаг 2/3. Машина та же — ${esc(lastCar)}?`,
    options: { reply_markup: carKeyboard() },
  };
}

export function buildPaymentPrompt(): ScreenPayload {
  return {
    text: "Шаг 3/3. Как оплатите курьеру при получении?",
    options: { reply_markup: paymentKeyboard() },
  };
}

export function buildSoftHint(): ScreenPayload {
  return {
    text: "Не совсем понял 🐾 Загляните в меню — там всё, что можно заказать.",
    options: {
      reply_markup: { inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]] },
    },
  };
}

// ============================================================================
// Приветствие / О нас / Меню (send* для обратной совместимости)
// ============================================================================

export async function sendWelcome(chatId: number): Promise<void> {
  const { text, options } = buildWelcome();
  await sendMessage(chatId, text, options);
}

export async function sendAbout(chatId: number): Promise<void> {
  const { text, options } = buildAbout();
  await sendMessage(chatId, text, options);
}

export async function sendMenu(
  chatId: number,
  items: MenuItemRow[],
  cart: CartItem[]
): Promise<void> {
  const { text, options } = buildMenu(items, cart);
  await sendMessage(chatId, text, options);
}

// ============================================================================
// Выбор варианта
// ============================================================================

export async function sendVariantPrompt(
  chatId: number,
  item: MenuItemRow
): Promise<void> {
  const screen = buildVariantPrompt(item);
  if (screen) await sendMessage(chatId, screen.text, screen.options);
}

// ============================================================================
// Корзина
// ============================================================================

export async function sendCart(chatId: number, cart: CartItem[]): Promise<void> {
  const { text, options } = buildCart(cart);
  await sendMessage(chatId, text, options);
}

// ============================================================================
// Оформление: шаги
// ============================================================================

export async function sendLandmarkPrompt(chatId: number): Promise<void> {
  const { text, options } = buildLandmarkPrompt();
  await sendMessage(chatId, text, options);
}

export async function sendLandmarkTextPrompt(chatId: number): Promise<void> {
  const { text, options } = buildLandmarkTextPrompt();
  await sendMessage(chatId, text, options);
}

export async function sendCarPromptNew(chatId: number): Promise<void> {
  const { text, options } = buildCarPromptNew();
  await sendMessage(chatId, text, options);
}

export async function sendCarPromptRepeat(
  chatId: number,
  lastCar: string
): Promise<void> {
  const { text, options } = buildCarPromptRepeat(lastCar);
  await sendMessage(chatId, text, options);
}

export async function sendPaymentPrompt(chatId: number): Promise<void> {
  const { text, options } = buildPaymentPrompt();
  await sendMessage(chatId, text, options);
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
// «Хочу 👀» (not_carried — присылает сообщение со ссылкой на группу)
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

export async function sendSoftHint(chatId: number): Promise<void> {
  const { text, options } = buildSoftHint();
  await sendMessage(chatId, text, options);
}

export async function sendError(chatId: number): Promise<void> {
  await sendMessage(chatId, "⚠️ Ой, что-то сломалось. Повторите, пожалуйста.");
}

export { groupUrl, mapUrl };
export { renderBulletLines, paymentLabel };
