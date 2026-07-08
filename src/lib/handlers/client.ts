/**
 * Клиентский поток (private chat).
 *
 * Всё состояние диалога — в user_sessions (state / context / cart / last_car).
 * На каждом апдейте: загрузить сессию → выполнить переход → сохранить сессию.
 *
 * Callback_data валидируется Zod-регексом (schemas.ts) до попадания сюда.
 * answerCallbackQuery вызывается в роутере в finally — тут этим не занимаемся,
 * кроме случая, когда нужно показать текстовый toast (через отдельный параметр).
 *
 * Тексты — SPEC.md, Блок 4. Не переписывать.
 */

import type { TgUpdateT, TgCallbackQueryT } from "@/lib/schemas";
import { CallbackData } from "@/lib/schemas";
import type {
  CartItem,
  MenuItemRow,
  PaymentMethod,
  UserSessionRow,
} from "@/types/database";
import { esc } from "@/lib/telegram/escape";
import { answerCallbackQuery, sendMessage } from "@/lib/telegram/api";
import {
  bumpDemand,
  createOrder,
  getAdminChatId,
  getMenuItems,
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
  sendAbout,
  sendCart,
  sendCarPromptNew,
  sendCarPromptRepeat,
  sendError,
  sendLandmarkPrompt,
  sendLandmarkTextPrompt,
  sendMenu,
  sendOrderConfirmation,
  sendPaymentPrompt,
  sendSoftHint,
  sendVariantPrompt,
  sendWantAck,
  sendWelcome,
} from "./screens";
import { sendOrderCard } from "./admin_card";

// ============================================================================
// Точка входа
// ============================================================================

export async function handleClientUpdate(
  update: TgUpdateT,
  session: UserSessionRow
): Promise<void> {
  // Callback имеет приоритет: приходит вместе с message, но обрабатывается как
  // взаимодействие с inline-клавиатурой.
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

  // /start — сброс и приветствие.
  if (text === "/start") {
    session.state = "browsing";
    session.cart = [];
    session.context = {};
    try {
      await saveSession(session);
      await sendWelcome(chatId);
    } catch (err) {
      console.error("client_start_failed", { user_id: session.user_id, err: String(err) });
      await safeError(chatId);
    }
    return;
  }

  // /menu — синоним кнопки меню.
  if (text === "/menu") {
    try {
      const items = await getMenuItems();
      await sendMenu(chatId, items, session.cart);
    } catch (err) {
      console.error("client_menu_failed", { user_id: session.user_id, err: String(err) });
      await safeError(chatId);
    }
    return;
  }

  // Ввод машины ожидаем в checkout_car (после car_new или без last_car).
  if (session.state === "checkout_car") {
    await handleCarInput(chatId, text, session);
    return;
  }

  // Ввод ориентира словами.
  if (session.state === "checkout_landmark_text") {
    await handleLandmarkTextInput(chatId, text, session);
    return;
  }

  // Всё остальное — мягкая подсказка.
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
    await saveSession(session);
    await sendPaymentPrompt(chatId);
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
  // Дальше — либо car_same, либо ввод машины.
  await afterLandmarkChosen(chatId, session);
}

// ============================================================================
// Callback_query
// ============================================================================

async function handleCallback(
  cb: TgCallbackQueryT,
  session: UserSessionRow
): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId) return; // без чата ничего не сделаем

  const raw = cb.data ?? "";
  const parsed = CallbackData.safeParse(raw);
  if (!parsed.success) {
    // Мусорный callback — игнор (роутер сам погасит «часики»).
    console.warn("client_callback_invalid", { data: raw });
    return;
  }
  const [action, arg1, arg2] = raw.split(":");

  try {
    switch (action) {
      case "menu": {
        const items = await getMenuItems();
        await sendMenu(chatId, items, session.cart);
        return;
      }
      case "cart": {
        await sendCart(chatId, session.cart);
        return;
      }
      case "about": {
        await sendAbout(chatId);
        return;
      }
      case "item": {
        await handleItemTap(chatId, arg1, session);
        return;
      }
      case "var": {
        await handleVariantTap(chatId, arg1, arg2, session);
        return;
      }
      case "add": {
        await handleAddTap(chatId, arg1, session);
        return;
      }
      case "inc": {
        await handleIncDec(chatId, arg1, session, "inc", cb.id);
        return;
      }
      case "dec": {
        await handleIncDec(chatId, arg1, session, "dec", cb.id);
        return;
      }
      case "want": {
        await handleWant(chatId, arg1);
        return;
      }
      case "checkout": {
        await handleCheckout(chatId, session, cb.id);
        return;
      }
      case "lm": {
        await handleLandmark(chatId, arg1, session);
        return;
      }
      case "car_same": {
        await handleCarSame(chatId, session, cb.id);
        return;
      }
      case "car_new": {
        await handleCarNew(chatId, session);
        return;
      }
      case "pay": {
        await handlePay(chatId, arg1, session, cb);
        return;
      }
      case "adm_status":
      case "adm_stop": {
        // Из приватного чата admin-кнопки игнорируем (защита от подмены, #13).
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

async function handleItemTap(
  chatId: number,
  slug: string | undefined,
  session: UserSessionRow
): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item) return;
  if (!item.available) {
    // Позицию сняли, пока клиент листал — сообщаем toast заменой сообщения.
    await sendMessage(chatId, "Уже разобрали 🙈");
    return;
  }
  if (item.variant_group) {
    session.state = "choosing_variant";
    session.context = { ...session.context, slug };
    await saveSession(session);
    await sendVariantPrompt(chatId, item);
    return;
  }
  // Без вариантов — сразу добавляем.
  const { cart, capped } = addToCart(session.cart, item, null);
  if (capped) {
    await sendMessage(chatId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "cart";
  await saveSession(session);
  await sendCart(chatId, session.cart);
}

async function handleVariantTap(
  chatId: number,
  slug: string | undefined,
  variantCode: string | undefined,
  session: UserSessionRow
): Promise<void> {
  if (!slug || !variantCode) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item) return;
  if (!item.available) {
    await sendMessage(chatId, "Уже разобрали 🙈");
    return;
  }
  const variantLabel = variantCodeToLabel(variantCode);
  if (!variantLabel) return;

  const { cart, capped } = addToCart(session.cart, item, variantLabel);
  if (capped) {
    await sendMessage(chatId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "cart";
  session.context = {};
  await saveSession(session);
  await sendCart(chatId, session.cart);
}

function variantCodeToLabel(code: string): string | null {
  switch (code) {
    case "syrup_yes":
      return "С сиропом";
    case "syrup_no":
      return "Без сиропа";
    case "tea_green":
      return "Зелёный";
    case "tea_black":
      return "Чёрный";
    default:
      return null;
  }
}

async function handleAddTap(
  chatId: number,
  slug: string | undefined,
  session: UserSessionRow
): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  if (!item || !item.available) {
    await sendMessage(chatId, "Уже разобрали 🙈");
    return;
  }
  const { cart, capped } = addToCart(session.cart, item, null);
  if (capped) {
    await sendMessage(chatId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = cart;
  session.state = "cart";
  await saveSession(session);
  await sendCart(chatId, session.cart);
}

// ============================================================================
// inc/dec
// ============================================================================

async function handleIncDec(
  chatId: number,
  idxStr: string | undefined,
  session: UserSessionRow,
  op: "inc" | "dec",
  cbId: string
): Promise<void> {
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0) return;

  const res =
    op === "inc" ? incCart(session.cart, idx) : decCart(session.cart, idx);
  if (res.notFound) {
    // Старый callback из прошлого сообщения (edge case #7).
    await answerCallbackQuery(cbId, "Корзина изменилась");
    await sendCart(chatId, session.cart);
    return;
  }
  if (op === "inc" && "capped" in res && res.capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
    return;
  }
  session.cart = res.cart;
  await saveSession(session);
  await sendCart(chatId, session.cart);
}

// ============================================================================
// «Хочу 👀»
// ============================================================================

async function handleWant(chatId: number, slug: string | undefined): Promise<void> {
  if (!slug) return;
  const items = await getMenuItems();
  const item = items.find((i) => i.slug === slug);
  const title = item?.title ?? slug;
  await bumpDemand(slug, title);
  await sendWantAck(chatId, title);
}

// ============================================================================
// Checkout: ориентир → машина → оплата
// ============================================================================

async function handleCheckout(
  chatId: number,
  session: UserSessionRow,
  cbId: string
): Promise<void> {
  if (session.cart.length === 0) {
    await answerCallbackQuery(cbId, "Корзина пуста");
    return;
  }
  // Перепроверка наличия (edge case #5).
  const items = await getMenuItems();
  const { cart, dropped } = filterAvailable(session.cart, items);
  if (dropped.length > 0) {
    session.cart = cart;
    await saveSession(session);
    const list = dropped.map((t) => `«${esc(t)}»`).join(", ");
    await sendMessage(
      chatId,
      `Пока вы собирали, ${list} закончилось. Убрали из заказа.`
    );
    if (cart.length === 0) {
      await sendCart(chatId, cart);
      return;
    }
  }
  session.state = "checkout_landmark";
  session.context = {};
  await saveSession(session);
  await sendLandmarkPrompt(chatId);
}

async function handleLandmark(
  chatId: number,
  code: string | undefined,
  session: UserSessionRow
): Promise<void> {
  if (!code) return;
  if (code === "text") {
    session.state = "checkout_landmark_text";
    await saveSession(session);
    await sendLandmarkTextPrompt(chatId);
    return;
  }
  if (code !== "entry" && code !== "middle" && code !== "tail") return;
  const landmark = landmarkLabel(code);
  session.context = { ...session.context, landmark };
  await afterLandmarkChosen(chatId, session);
}

async function afterLandmarkChosen(
  chatId: number,
  session: UserSessionRow
): Promise<void> {
  if (session.last_car && session.last_car.length > 0) {
    session.state = "checkout_car";
    await saveSession(session);
    await sendCarPromptRepeat(chatId, session.last_car);
  } else {
    session.state = "checkout_car";
    await saveSession(session);
    await sendCarPromptNew(chatId);
  }
}

async function handleCarSame(
  chatId: number,
  session: UserSessionRow,
  cbId: string
): Promise<void> {
  if (!session.last_car) {
    await answerCallbackQuery(cbId, "Нет прошлой машины, напишите текстом");
    await sendCarPromptNew(chatId);
    return;
  }
  session.context = { ...session.context, car: session.last_car };
  session.state = "checkout_payment";
  await saveSession(session);
  await sendPaymentPrompt(chatId);
}

async function handleCarNew(
  chatId: number,
  session: UserSessionRow
): Promise<void> {
  session.state = "checkout_car";
  await saveSession(session);
  await sendCarPromptNew(chatId);
}

// ============================================================================
// Оплата → создание заказа (защита от двойного заказа, edge case #12)
// ============================================================================

async function handlePay(
  chatId: number,
  method: string | undefined,
  session: UserSessionRow,
  cb: TgCallbackQueryT
): Promise<void> {
  const cbId = cb.id;
  // Защита от двойного заказа: обрабатываем только если state == checkout_payment.
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
    // Что-то потерялось (напр. сессия в невалидном виде) — на безопасный путь.
    console.warn("client_pay_missing_context", {
      user_id: session.user_id,
      has_car: !!car,
      has_landmark: !!landmark,
      cart_len: cart.length,
    });
    session.state = "browsing";
    session.context = {};
    await saveSession(session);
    await sendMessage(chatId, "Что-то потерялось. Начнём заново с меню.");
    return;
  }

  const totalKop = cartTotalKop(cart);

  // КРИТИЧНО: переводим state в browsing и сохраняем ДО отправки в Telegram.
  // Если Telegram-апдейт ретраится или клиент дабл-кликнул — повторный pay:*
  // придёт в state=browsing и уйдёт в «Заказ уже оформлен».
  const snapshotCart = cart.slice();
  session.state = "browsing";
  session.cart = [];
  session.context = {};
  await saveSession(session);

  let orderNumber: number | null = null;
  let orderId: string | null = null;
  try {
    const order = await createOrder({
      user_id: session.user_id,
      username: session.username,
      items: snapshotCart,
      total_kop: totalKop,
      landmark,
      car,
      payment_method: paymentMethod,
    });
    orderNumber = order.order_number;
    orderId = order.id;

    // Отправить карточку в admin-чат (не критично — если чат не привязан,
    // заказ сохранён, клиенту всё равно подтверждаем).
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

    // Подтверждение клиенту.
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
    // Заказ не создан — вернуть корзину клиенту и state=checkout_payment,
    // чтобы он мог повторить.
    session.state = "checkout_payment";
    session.cart = snapshotCart;
    session.context = { car, landmark };
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

  // Заглушим неиспользуемое предупреждение — paymentLabel мы не зовём здесь напрямую.
  void paymentLabel;
}

// ============================================================================
// Утилита: безопасный вызов sendError (не бросит наружу)
// ============================================================================

async function safeError(chatId: number): Promise<void> {
  try {
    await sendError(chatId);
  } catch (err) {
    console.error("send_error_failed", { chat_id: chatId, err: String(err) });
  }
}

// Реэкспорт для тестов, если понадобится.
export { MAX_QTY };

// Отсылка к типу MenuItemRow чтобы линтер не ругался при dev-переработке.
void (0 as unknown as MenuItemRow);
