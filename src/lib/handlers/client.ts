/**
 * Клиентский поток (private chat).
 *
 * Всё состояние диалога — в user_sessions (state / context / cart / last_car).
 * На каждом апдейте: загрузить сессию → выполнить переход → сохранить сессию.
 *
 * Callback_data валидируется Zod-регексом (schemas.ts) до попадания сюда.
 * answerCallbackQuery вызывается в роутере в finally — тут этим не занимаемся,
 * кроме случая, когда нужно показать текстовый toast.
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
  createOrder,
  getAdminChatId,
  getMenuItems,
  recordDemandEvent,
  releaseReserved,
  reserveStock,
  returnReserved,
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
  if (!chatId) return;

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
        await handleItemTap(chatId, arg1, session, cb.id);
        return;
      }
      case "var": {
        await handleVariantTap(chatId, arg1, arg2, session, cb.id);
        return;
      }
      case "add": {
        await handleAddTap(chatId, arg1, session, cb.id);
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
        await handleWant(chatId, arg1, cb.id, cb.from.id);
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
  return item.available && item.stock_qty > 0;
}

async function handleItemTap(
  chatId: number,
  slug: string | undefined,
  session: UserSessionRow,
  cbId: string
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
    session.state = "choosing_variant";
    session.context = { ...session.context, slug };
    await saveSession(session);
    await sendVariantPrompt(chatId, item);
    return;
  }
  const { cart, capped } = addToCart(session.cart, item, null);
  if (capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
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
  session: UserSessionRow,
  cbId: string
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
  if (!variantLabel) return;

  const { cart, capped } = addToCart(session.cart, item, variantLabel);
  if (capped) {
    await answerCallbackQuery(cbId, "Больше 20 не принимаем 🙂");
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
  session: UserSessionRow,
  cbId: string
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
  const kind = item?.field_item ? "sold_out" : "not_carried";

  await recordDemandEvent(slug, title, kind, fromUserId);

  const toastText =
    kind === "sold_out"
      ? "Уже разобрали 🙈 Записали, что ждёте"
      : "Записали! 🐾 Наберётся спрос — привезём";
  await answerCallbackQuery(cbId, toastText);

  if (kind === "sold_out") {
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

  // sendWantAck for not_carried (optional nice touch — sends a message with group link)
  if (kind === "not_carried") {
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
  cbId: string
): Promise<void> {
  if (session.cart.length === 0) {
    await answerCallbackQuery(cbId, "Корзина пуста");
    return;
  }
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
// Оплата → резервация → создание заказа
// ============================================================================

async function handlePay(
  chatId: number,
  method: string | undefined,
  session: UserSessionRow,
  cb: TgCallbackQueryT
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
    await saveSession(session);
    await sendMessage(chatId, "Что-то потерялось. Начнём заново с меню.");
    return;
  }

  // 1. Reserve stock atomically before creating the order
  let reserveResult;
  try {
    reserveResult = await reserveStock(cart);
  } catch (err) {
    console.error("reserve_stock_failed", { user_id: session.user_id, err: String(err) });
    await safeError(chatId);
    return;
  }

  if (!reserveResult.ok) {
    // Some items ran out — correct cart and return to cart screen
    const shortBySlug = new Map(reserveResult.short.map((s) => [s.slug, s.available]));
    const correctedCart: CartItem[] = [];
    const adjustedTitles: string[] = [];

    for (const item of cart) {
      const available = shortBySlug.get(item.slug);
      if (available === undefined) {
        // Item was fully available
        correctedCart.push(item);
      } else if (available > 0) {
        // Partially available — trim qty
        correctedCart.push({ ...item, qty: available });
        adjustedTitles.push(`${esc(item.title)} (осталось ${available} шт)`);
      } else {
        // Fully out — remove
        adjustedTitles.push(`${esc(item.title)} (закончилось)`);
      }
    }

    session.cart = correctedCart;
    session.state = "cart";
    await saveSession(session);

    if (adjustedTitles.length > 0) {
      await sendMessage(
        chatId,
        `Остатков не хватило:\n${adjustedTitles.join("\n")}\nПоправили заказ — проверьте и оформите снова 🙏`
      );
    }
    await sendCart(chatId, correctedCart);
    return;
  }

  const totalKop = cartTotalKop(cart);
  const snapshotCart = cart.slice();

  // КРИТИЧНО: сбрасываем state ДО отправки в Telegram (защита от двойного заказа)
  session.state = "browsing";
  session.cart = [];
  session.context = {};
  await saveSession(session);

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
    // Order was NOT created — return reserved stock
    try {
      await returnReserved(snapshotCart);
    } catch (retErr) {
      console.error("return_reserved_on_rollback_failed", {
        user_id: session.user_id,
        err: String(retErr),
      });
    }
    // Restore session
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

  void paymentLabel;
  void releaseReserved;
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

export { MAX_QTY };
void (0 as unknown as MenuItemRow);
