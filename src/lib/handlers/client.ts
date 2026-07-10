/**
 * Клиентский поток (private chat).
 *
 * v1.1: единственный UI-экран на клиента. renderScreen редактирует или шлёт новое.
 * ui_message_id для callback берётся из cb.message (self-recovery при рассинхроне).
 * Для текстового ввода: deleteOldUi → sendMessage → обновить id.
 * Для pay:* : deleteOldUi (экран оплаты) → sendOrderConfirmation → ui_message_id = null.
 *
 * Инвариант: корзина/state пишутся в БД ДО отправки в Telegram.
 */

import type { TgUpdateT, TgCallbackQueryT } from "@/lib/schemas";
import { CallbackData } from "@/lib/schemas";
import type {
  CartItem,
  MenuItemRow,
  PaymentMethod,
  UserSessionRow,
} from "@/types/database";
import { answerCallbackQuery, sendMessage } from "@/lib/telegram/api";
import {
  createOrder,
  decrementStock,
  getAdminChatId,
  getCurrentShift,
  getMenuItems,
  recordDemandEvent,
  returnStock,
  saveSession,
  setOrderAdminMessageId,
} from "@/lib/supabase/queries";
import {
  addToCart,
  decCart,
  filterAvailable,
  incCart,
  MAX_QTY,
  truncate,
} from "./cart";
import {
  cartTotalKop,
  landmarkLabel,
  paymentLabel,
} from "./format";
import {
  buildAbout,
  buildCart,
  buildCarPromptNew,
  buildCarPromptRepeat,
  buildLandmarkPrompt,
  buildLandmarkTextPrompt,
  buildMenu,
  buildPaymentPrompt,
  buildSoftHint,
  buildVariantPrompt,
  buildWelcome,
  sendError,
  sendOrderConfirmation,
  sendWantAck,
} from "./screens";
import { deleteOldUi, renderScreen } from "./render";
import { sendOrderCard } from "./admin_card";
import { updateWaitlistBoard } from "./waitlist";

// ============================================================================
// Точка входа
// ============================================================================

export async function handleClientUpdate(
  update: TgUpdateT,
  session: UserSessionRow
): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, session);
    return;
  }
  if (update.message) {
    await handleMessage(update, session);
  }
}

// ============================================================================
// Текстовые сообщения
// ============================================================================

async function handleMessage(
  update: TgUpdateT,
  session: UserSessionRow
): Promise<void> {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start") {
    const oldUiMsgId = session.ui_message_id;
    session.state = "browsing";
    session.cart = [];
    session.context = {};
    try {
      await deleteOldUi(chatId, oldUiMsgId);
      const screen = buildWelcome();
      const result = await sendMessage(chatId, screen.text, screen.options);
      session.ui_message_id = result.message_id;
      await saveSession(session);
    } catch (err) {
      console.error("client_start_failed", { user_id: session.user_id, err: String(err) });
      await safeError(chatId);
    }
    return;
  }

  if (text === "/menu") {
    try {
      const oldUiMsgId = session.ui_message_id;
      await deleteOldUi(chatId, oldUiMsgId);
      const items = await getMenuItems();
      const screen = buildMenu(items, session.cart);
      const result = await sendMessage(chatId, screen.text, screen.options);
      session.ui_message_id = result.message_id;
      await saveSession(session);
    } catch (err) {
      console.error("client_menu_failed", { user_id: session.user_id, err: String(err) });
      await safeError(chatId);
    }
    return;
  }

  if (session.state === "checkout_car") {
    await handleCarInput(chatId, text, session);
    return;
  }

  if (session.state === "checkout_landmark_text") {
    await handleLandmarkTextInput(chatId, text, session);
    return;
  }

  await sendSoftHint(chatId);
}

async function handleCarInput(
  chatId: number,
  text: string,
  session: UserSessionRow
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length < 3) {
    await sendMessage(chatId, "Слишком коротко, опишите машину подробнее.");
    return;
  }
  const { text: car, truncated: carTruncated } = truncate(trimmed, 100);
  if (carTruncated) {
    await sendMessage(chatId, "Обрезали до 100 символов, остальное не войдёт.");
  }
  session.context = { ...session.context, car };
  session.last_car = car;
  session.state = "checkout_payment";
  try {
    await deleteOldUi(chatId, session.ui_message_id);
    const screen = buildPaymentPrompt();
    const result = await sendMessage(chatId, screen.text, screen.options);
    session.ui_message_id = result.message_id;
    await saveSession(session);
  } catch (err) {
    console.error("client_car_input_failed", { user_id: session.user_id, err: String(err) });
    await safeError(chatId);
  }
}

async function handleLandmarkTextInput(
  chatId: number,
  text: string,
  session: UserSessionRow
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await sendMessage(chatId, "Напишите ориентир одним сообщением.");
    return;
  }
  const { text: landmark, truncated: lmTruncated } = truncate(trimmed, 100);
  if (lmTruncated) {
    await sendMessage(chatId, "Обрезали до 100 символов, остальное не войдёт.");
  }
  session.context = { ...session.context, landmark };
  try {
    await deleteOldUi(chatId, session.ui_message_id);
    await afterLandmarkChosen(chatId, session, null);
  } catch (err) {
    console.error("client_landmark_text_failed", { user_id: session.user_id, err: String(err) });
    await safeError(chatId);
  }
}

// ============================================================================
// Callback_query
// ============================================================================

async function handleCallback(
  cb: TgCallbackQueryT,
  session: UserSessionRow
): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId) return;

  // Берём message_id из callback-сообщения — self-recovery при рассинхроне ui_message_id.
  const uiMsgId = cb.message?.message_id ?? null;

  const raw = cb.data ?? "";
  const parsed = CallbackData.safeParse(raw);
  if (!parsed.success) {
    console.warn("client_callback_invalid", { data: raw });
    return;
  }
  const parts = raw.split(":");
  const action = parts[0];
  const arg1 = parts[1];
  const arg2 = parts[2];

  try {
    switch (action) {
      case "menu": {
        const items = await getMenuItems();
        const screen = buildMenu(items, session.cart);
        const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
        session.ui_message_id = newId;
        await saveSession(session);
        return;
      }
      case "cart": {
        const screen = buildCart(session.cart);
        const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
        session.ui_message_id = newId;
        await saveSession(session);
        return;
      }
      case "about": {
        const screen = buildAbout();
        const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
        session.ui_message_id = newId;
        await saveSession(session);
        return;
      }
      case "item": {
        await handleItemTap(chatId, arg1, session, cb.id, uiMsgId);
        return;
      }
      case "var": {
        await handleVariantTap(chatId, arg1, arg2, session, cb.id, uiMsgId);
        return;
      }
      case "add": {
        await handleAddTap(chatId, arg1, session, cb.id, uiMsgId);
        return;
      }
      case "inc": {
        await handleIncDec(chatId, arg1, session, "inc", cb.id, uiMsgId);
        return;
      }
      case "dec": {
        await handleIncDec(chatId, arg1, session, "dec", cb.id, uiMsgId);
        return;
      }
      case "del": {
        await handleDel(chatId, arg1, session, cb.id, uiMsgId);
        return;
      }
      case "want": {
        await handleWant(chatId, arg1, cb.id, cb.from.id);
        return;
      }
      case "checkout": {
        await handleCheckout(chatId, session, cb.id, uiMsgId);
        return;
      }
      case "lm": {
        await handleLandmark(chatId, arg1, session, uiMsgId);
        return;
      }
      case "car_same": {
        await handleCarSame(chatId, session, cb.id, uiMsgId);
        return;
      }
      case "car_new": {
        await handleCarNew(chatId, session, uiMsgId);
        return;
      }
      case "pay": {
        await handlePay(chatId, arg1, session, cb, uiMsgId);
        return;
      }
      case "adm_status":
      case "adm_stop":
      case "adm_panel":
      case "adm_stk":
      case "adm_avail": {
        // Admin callbacks из приватного чата — игнор (#13).
        return;
      }
      default:
        console.warn("client_unknown_action", { action });
    }
  } catch (err) {
    console.error("client_callback_failed", {
      user_id: session.user_id,
      action,
      err: String(err),
    });
    await safeError(chatId);
  }
}

// ============================================================================
// Меню / выбор позиции
// ============================================================================

function isAvailable(item: MenuItemRow): boolean {
  return item.available && item.stock > 0;
}

async function handleItemTap(
  chatId: number,
  slug: string | undefined,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item) return;
  if (!isAvailable(item)) {
    await answerCallbackQuery(cbId, "Уже разобрали 🙈");
    return;
  }
  if (item.variant_group) {
    const screen = buildVariantPrompt(item);
    if (!screen) return;
    session.state = "choosing_variant";
    session.context = { ...session.context, slug };
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  const { cart, capped } = addToCart(session.cart, item, null);
  if (capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "browsing";
  await answerCallbackQuery(cbId, `${item.title} добавлен ✅`);
  const screen = buildMenu(items, session.cart);
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

async function handleVariantTap(
  chatId: number,
  slug: string | undefined,
  variantCode: string | undefined,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (!slug || !variantCode) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item) return;
  if (!isAvailable(item)) {
    await answerCallbackQuery(cbId, "Уже разобрали 🙈");
    return;
  }
  const variantLabel = variantCodeToLabel(variantCode);
  if (!variantLabel) {
    // Unknown/old variant code — show toast and re-render the variant picker.
    await answerCallbackQuery(cbId, "Меню обновилось — выбери снова 🙂");
    const screen = buildVariantPrompt(item);
    if (screen) {
      const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
      session.ui_message_id = newId;
      await saveSession(session);
    }
    return;
  }

  const { cart, capped } = addToCart(session.cart, item, variantLabel);
  if (capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "browsing";
  session.context = {};
  const toastText = `${item.title} (${variantLabel.toLowerCase()}) добавлен ✅`;
  await answerCallbackQuery(cbId, toastText);
  const screen = buildMenu(items, session.cart);
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

function variantCodeToLabel(code: string): string | null {
  switch (code) {
    // Syrups (v1.1)
    case "s_none":
      return "Без сиропа";
    case "s_caramel":
      return "Солёная карамель";
    case "s_coconut":
      return "Кокос";
    case "s_vanilla":
      return "Ваниль";
    // Tea
    case "tea_green":
      return "Зелёный с гуавой";
    case "tea_black":
      return "Чёрный с абрикосом";
    // Legacy syrup codes — return null to trigger graceful fallback
    default:
      return null;
  }
}

async function handleAddTap(
  chatId: number,
  slug: string | undefined,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item || !isAvailable(item)) {
    await answerCallbackQuery(cbId, "Уже разобрали 🙈");
    return;
  }
  const { cart, capped } = addToCart(session.cart, item, null);
  if (capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "browsing";
  await answerCallbackQuery(cbId, `${item.title} добавлен ✅`);
  const screen = buildMenu(items, session.cart);
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

// ============================================================================
// inc/dec/del
// ============================================================================

async function handleIncDec(
  chatId: number,
  idxStr: string | undefined,
  session: UserSessionRow,
  op: "inc" | "dec",
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0) return;

  const res =
    op === "inc" ? incCart(session.cart, idx) : decCart(session.cart, idx);
  if (res.notFound) {
    await answerCallbackQuery(cbId, "Корзина изменилась");
    const screen = buildCart(session.cart);
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  if (op === "inc" && "capped" in res && res.capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = res.cart;
  const screen = buildCart(session.cart);
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

async function handleDel(
  chatId: number,
  idxStr: string | undefined,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (!idxStr) return;
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0 || idx >= session.cart.length) {
    await answerCallbackQuery(cbId, "Корзина изменилась");
    const screen = buildCart(session.cart);
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  const newCart = session.cart.slice();
  newCart.splice(idx, 1);
  session.cart = newCart;
  const screen = buildCart(session.cart);
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

// ============================================================================
// «Хочу 👀»
// ============================================================================

async function handleWant(
  chatId: number,
  slug: string | undefined,
  cbId: string,
  fromUserId: number
): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  const title = item?.title ?? slug;
  // sold_out — позиция есть в каталоге, но stock = 0; unavailable — снята или не в каталоге
  const reason = (item && item.stock === 0) ? "sold_out" as const : "unavailable" as const;

  await recordDemandEvent(slug, title, fromUserId, reason);

  const toastText =
    reason === "sold_out"
      ? "Уже разобрали 🙈 Записали, что ждёте"
      : "Записали! 🐾 Наберётся спрос — привезём";
  await answerCallbackQuery(cbId, toastText);

  if (reason === "sold_out") {
    try {
      const adminChatId = await getAdminChatId();
      if (adminChatId !== null) {
        await updateWaitlistBoard(Number(adminChatId));
      }
    } catch (err) {
      console.error("waitlist_board_update_failed", {
        slug,
        chat_id: chatId,
        err: String(err),
      });
    }
  }

  if (reason === "unavailable") {
    try {
      await sendWantAck(chatId, title);
    } catch {
      // Non-critical
    }
  }
}

// ============================================================================
// Checkout: ориентир → машина → оплата
// ============================================================================

async function handleCheckout(
  chatId: number,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (session.cart.length === 0) {
    await answerCallbackQuery(cbId, "Корзина пуста");
    return;
  }
  const items = await getMenuItems();
  const { cart, dropped } = filterAvailable(session.cart, items);
  if (dropped.length > 0) {
    session.cart = cart;
    await answerCallbackQuery(cbId, "Часть позиций закончилась — корзину обновили 🛒");
    const screen = buildCart(cart);
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  session.state = "checkout_landmark";
  session.context = {};
  const screen = buildLandmarkPrompt();
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

async function handleLandmark(
  chatId: number,
  code: string | undefined,
  session: UserSessionRow,
  uiMsgId: number | null
): Promise<void> {
  if (!code) return;
  if (code === "text") {
    session.state = "checkout_landmark_text";
    const screen = buildLandmarkTextPrompt();
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  if (code !== "entry" && code !== "middle" && code !== "tail") return;
  const landmark = landmarkLabel(code);
  session.context = { ...session.context, landmark };
  await afterLandmarkChosen(chatId, session, uiMsgId);
}

async function afterLandmarkChosen(
  chatId: number,
  session: UserSessionRow,
  uiMsgId: number | null
): Promise<void> {
  session.state = "checkout_car";
  let screen;
  if (session.last_car && session.last_car.length > 0) {
    screen = buildCarPromptRepeat(session.last_car);
  } else {
    screen = buildCarPromptNew();
  }
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

async function handleCarSame(
  chatId: number,
  session: UserSessionRow,
  cbId: string,
  uiMsgId: number | null
): Promise<void> {
  if (!session.last_car) {
    await answerCallbackQuery(cbId, "Нет прошлой машины, напишите текстом");
    session.state = "checkout_car";
    const screen = buildCarPromptNew();
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }
  session.context = { ...session.context, car: session.last_car };
  session.state = "checkout_payment";
  const screen = buildPaymentPrompt();
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

async function handleCarNew(
  chatId: number,
  session: UserSessionRow,
  uiMsgId: number | null
): Promise<void> {
  session.state = "checkout_car";
  const screen = buildCarPromptNew();
  const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
  session.ui_message_id = newId;
  await saveSession(session);
}

// ============================================================================
// Оплата → резервация → создание заказа
// ============================================================================

async function handlePay(
  chatId: number,
  method: string | undefined,
  session: UserSessionRow,
  cb: TgCallbackQueryT,
  uiMsgId: number | null
): Promise<void> {
  const cbId = cb.id;
  if (session.state !== "checkout_payment") {
    await answerCallbackQuery(cbId, "Заказ уже оформлен");
    return;
  }
  if (method !== "sbp" && method !== "cash" && method !== "terminal") return;
  const paymentMethod = method as PaymentMethod;

  const car = (session.context?.car as string | undefined) ?? "";
  const landmark = (session.context?.landmark as string | undefined) ?? "";
  const cart: CartItem[] = session.cart;

  if (!car || !landmark || cart.length === 0) {
    console.warn("client_pay_missing_context", {
      user_id: session.user_id,
      has_car: !!car,
      has_landmark: !!landmark,
      cart_len: cart.length,
    });
    session.state = "browsing";
    session.context = {};
    session.ui_message_id = null;
    await saveSession(session);
    await sendMessage(chatId, "Что-то потерялось. Начнём заново с меню.");
    return;
  }

  // 1. Проверить наличие открытой смены (Edge Case 5)
  let currentShift;
  try {
    currentShift = await getCurrentShift();
  } catch (err) {
    console.error("get_current_shift_failed", { user_id: session.user_id, err: String(err) });
    await safeError(chatId);
    return;
  }
  if (!currentShift) {
    await answerCallbackQuery(cbId, "⚠️ Приём заказов приостановлен");
    await sendMessage(
      chatId,
      "⚠️ Приём заказов временно приостановлен.\nПопробуйте через несколько минут."
    );
    return;
  }

  // 2. Отфильтровать недоступные позиции (available=false или stock=0)
  const items = await getMenuItems();
  const { cart: filteredCart, dropped } = filterAvailable(cart, items);

  if (dropped.length > 0 && filteredCart.length === 0) {
    // Edge Case 3: корзина опустела — заказ не создаём
    session.state = "browsing";
    session.cart = [];
    session.context = {};
    session.ui_message_id = null;
    await saveSession(session);
    await deleteOldUi(chatId, uiMsgId);
    await sendMessage(
      chatId,
      "Всё из вашего заказа разобрали 🙈\nВыберите что-то другое!",
      { reply_markup: { inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]] } }
    );
    return;
  }

  if (dropped.length > 0) {
    // Edge Case 2: часть позиций снята — обновляем корзину, возвращаем на cart
    session.cart = filteredCart;
    session.state = "cart";
    await answerCallbackQuery(cbId, "Часть позиций закончилась — корзину обновили 🛒");
    const screen = buildCart(filteredCart);
    const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
    session.ui_message_id = newId;
    await saveSession(session);
    return;
  }

  // 3. Атомарное списание (Edge Case 1: гонка за последнюю штуку)
  try {
    await decrementStock(filteredCart);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("insufficient_stock:")) {
      // Парсим, каких slug не хватило
      const failedSlugs = new Set(
        msg.replace(/^.*insufficient_stock:/, "").split(",").map((s) => s.trim())
      );
      const corrected = filteredCart.filter((it) => !failedSlugs.has(it.slug));

      if (corrected.length === 0) {
        // Edge Case 3: всё разобрали
        session.state = "browsing";
        session.cart = [];
        session.context = {};
        session.ui_message_id = null;
        await saveSession(session);
        await deleteOldUi(chatId, uiMsgId);
        await sendMessage(
          chatId,
          "Всё из вашего заказа разобрали 🙈\nВыберите что-то другое!",
          { reply_markup: { inline_keyboard: [[{ text: "🧋 Меню", callback_data: "menu" }]] } }
        );
        return;
      }

      session.cart = corrected;
      session.state = "cart";
      const failedTitles = filteredCart
        .filter((it) => failedSlugs.has(it.slug))
        .map((it) => it.title)
        .join(", ");
      await answerCallbackQuery(
        cbId,
        `${failedTitles} разобрали — убрали из заказа. Оформить остальное?`
      );
      const screen = buildCart(corrected);
      const newId = await renderScreen(chatId, uiMsgId, screen.text, screen.options);
      session.ui_message_id = newId;
      await saveSession(session);
      return;
    }
    console.error("decrement_stock_failed", { user_id: session.user_id, err: msg });
    await safeError(chatId);
    return;
  }

  const totalKop = cartTotalKop(filteredCart);
  const snapshotCart = filteredCart.slice();

  // КРИТИЧНО: сбрасываем state ДО отправки в Telegram (защита от двойного заказа).
  session.state = "browsing";
  session.cart = [];
  session.context = {};
  session.ui_message_id = null;
  await saveSession(session);

  // Удалить экран оплаты перед отправкой чека (best-effort).
  await deleteOldUi(chatId, uiMsgId);

  let orderId: string | null = null;
  let orderNumber: number | null = null;
  try {
    const order = await createOrder({
      user_id: session.user_id,
      username: session.username,
      items: snapshotCart,
      total_kop: totalKop,
      landmark,
      car,
      payment_method: paymentMethod,
      shift_id: currentShift.id,
    });
    orderId = order.id;
    orderNumber = order.order_number;

    try {
      const adminChatId = await getAdminChatId();
      if (adminChatId !== null) {
        const messageId = await sendOrderCard(Number(adminChatId), order);
        if (messageId) {
          await setOrderAdminMessageId(orderId, messageId);
        }
      } else {
        console.warn("admin_chat_not_bound", { order_id: orderId });
      }
    } catch (adminErr) {
      console.error("send_order_card_failed", {
        order_id: orderId,
        err: String(adminErr),
      });
    }

    await sendOrderConfirmation(chatId, {
      orderNumber,
      cart: snapshotCart,
      totalKop,
      payment: paymentMethod,
      car,
      landmark,
    });
  } catch (err) {
    console.error("create_order_failed", {
      user_id: session.user_id,
      err: String(err),
    });
    // Заказ НЕ создан, но stock уже был списан — возвращаем остаток
    try {
      await returnStock(snapshotCart);
    } catch (retErr) {
      console.error("return_stock_on_rollback_failed", {
        user_id: session.user_id,
        err: String(retErr),
      });
    }
    // Восстановить сессию
    session.state = "checkout_payment";
    session.cart = snapshotCart;
    session.context = { car, landmark };
    session.ui_message_id = null;
    try {
      await saveSession(session);
    } catch (saveErr) {
      console.error("rollback_session_failed", {
        user_id: session.user_id,
        err: String(saveErr),
      });
    }
    await safeError(chatId);
  }

  void paymentLabel;
}

// ============================================================================
// Утилита: безопасный вызов sendError
// ============================================================================

async function safeError(chatId: number): Promise<void> {
  try {
    await sendError(chatId);
  } catch (err) {
    console.error("send_error_failed", { chat_id: chatId, err: String(err) });
  }
}

// ============================================================================
// Мелкие функции для sendSoftHint (вызывается из handleMessage напрямую)
// ============================================================================

async function sendSoftHint(chatId: number): Promise<void> {
  try {
    const screen = buildSoftHint();
    await sendMessage(chatId, screen.text, screen.options);
  } catch (err) {
    console.error("send_soft_hint_failed", { chat_id: chatId, err: String(err) });
  }
}

export { MAX_QTY };
void (0 as unknown as MenuItemRow);
