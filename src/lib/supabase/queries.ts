/**
 * Все обращения к БД проходят здесь. Server-only, использует service-role клиент.
 *
 * Принципы (SPEC.md, Блок 2 / rules/database.md):
 * - Атомарные операции — через RPC (next_order_number, bump_demand), никакого
 *   read-modify-write счётчиков в JS.
 * - Заказ — снапшот корзины (JSONB), не нормализуется.
 * - «Сегодня» в отчётах — Europe/Moscow, а не UTC.
 * - Деньги — INTEGER в копейках. Никаких float.
 */

// NB: server-only по контракту (см. client.ts). Пакет `server-only` не в deps.
// import "server-only";
import { supabase } from "@/lib/supabase/client";
import type {
  CartItem,
  MenuItemRow,
  OrderRow,
  OrderStatus,
  PaymentMethod,
  UserSessionRow,
} from "@/types/database";

// ============================================================================
// Служебные типы
// ============================================================================

/** Данные для создания заказа. Номер выдаётся RPC. */
export type CreateOrderData = {
  user_id: number;
  username: string | null;
  items: CartItem[];
  total_kop: number;
  landmark: string;
  car: string;
  payment_method: PaymentMethod;
};

/** Дневная сводка для /стат. */
export type DailyStats = {
  /** Количество заказов за сегодня (не cancelled). */
  count: number;
  /** Общая выручка за сегодня в копейках (не cancelled). */
  total_kop: number;
  /** Разбивка сумм по способам оплаты (копейки; только не cancelled). */
  by_payment: Record<PaymentMethod, number>;
  /** Топ заказанных позиций (по количеству штук, DESC). Только не cancelled. */
  top_items: Array<{ title: string; qty: number }>;
  /** Топ спроса «хочу 👀» (DESC по clicks). */
  top_demand: Array<{ title: string; clicks: number }>;
};

// ============================================================================
// user_sessions
// ============================================================================

/**
 * Загрузить или создать сессию по Telegram user_id. UPSERT по PK, обновляем
 * username на актуальный (пользователь мог сменить). state/cart/context при
 * первом заходе — дефолты из БД.
 */
export async function getOrCreateSession(
  userId: number,
  username?: string
): Promise<UserSessionRow> {
  // Сначала пробуем прочитать — сохраняем существующий state, cart, context.
  const { data: existing, error: readErr } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) {
    throw new Error(`getOrCreateSession read failed: ${readErr.message}`);
  }

  if (existing) {
    // Актуализируем username, если пришёл новый.
    if (username !== undefined && existing.username !== username) {
      const { error: updErr } = await supabase
        .from("user_sessions")
        .update({ username })
        .eq("user_id", userId);
      if (updErr) {
        // Не фатально — просто лог.
        console.warn("session_username_update_failed", {
          user_id: userId,
          error: updErr.message,
        });
      } else {
        existing.username = username;
      }
    }
    return existing as UserSessionRow;
  }

  // Новой сессии нет — вставляем с дефолтами.
  const { data: inserted, error: insErr } = await supabase
    .from("user_sessions")
    .insert({
      user_id: userId,
      username: username ?? null,
      state: "browsing",
      context: {},
      cart: [],
    })
    .select("*")
    .single();

  if (insErr || !inserted) {
    throw new Error(`getOrCreateSession insert failed: ${insErr?.message ?? "no row"}`);
  }
  return inserted as UserSessionRow;
}

/**
 * Сохранить сессию (UPDATE по user_id). Обновляем state, context, cart,
 * last_car, username — всё, что меняется в ходе диалога.
 */
export async function saveSession(session: UserSessionRow): Promise<void> {
  const { error } = await supabase
    .from("user_sessions")
    .update({
      username: session.username,
      state: session.state,
      context: session.context,
      cart: session.cart,
      last_car: session.last_car,
    })
    .eq("user_id", session.user_id);

  if (error) {
    throw new Error(`saveSession failed: ${error.message}`);
  }
}

// ============================================================================
// menu_items
// ============================================================================

/**
 * Все позиции полевого меню (`field_item = true`), отсортированные по sort_order.
 * Возвращаем и available=true, и available=false — рендер разделит на две секции
 * («в наличии» и «сегодня нет 👀»).
 */
export async function getMenuItems(): Promise<MenuItemRow[]> {
  const { data, error } = await supabase
    .from("menu_items")
    .select("*")
    .eq("field_item", true)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(`getMenuItems failed: ${error.message}`);
  }
  return (data ?? []) as MenuItemRow[];
}

/**
 * Инвертировать флаг available у позиции по slug. Возвращает НОВОЕ значение.
 * Реализовано двумя запросами (read + update) — гонка тут не опасна: /стоп
 * жмут редко, сотрудник один в моменте. Если станет критично — вынести в RPC.
 */
export async function toggleAvailability(slug: string): Promise<boolean> {
  const { data: current, error: readErr } = await supabase
    .from("menu_items")
    .select("available")
    .eq("slug", slug)
    .maybeSingle();

  if (readErr) {
    throw new Error(`toggleAvailability read failed: ${readErr.message}`);
  }
  if (!current) {
    throw new Error(`toggleAvailability: slug not found: ${slug}`);
  }

  const next = !current.available;
  const { error: updErr } = await supabase
    .from("menu_items")
    .update({ available: next })
    .eq("slug", slug);

  if (updErr) {
    throw new Error(`toggleAvailability update failed: ${updErr.message}`);
  }
  return next;
}

// ============================================================================
// orders
// ============================================================================

/**
 * Создать заказ. Номер выдаётся атомарным RPC next_order_number() (защита от
 * гонок между параллельными serverless-инстансами).
 *
 * admin_message_id не выставляется здесь — оно проставляется позже, после
 * отправки карточки в admin-чат.
 */
export async function createOrder(data: CreateOrderData): Promise<OrderRow> {
  const { data: numRes, error: rpcErr } = await supabase.rpc("next_order_number");
  if (rpcErr || typeof numRes !== "number") {
    throw new Error(`next_order_number RPC failed: ${rpcErr?.message ?? "no number"}`);
  }

  const { data: inserted, error: insErr } = await supabase
    .from("orders")
    .insert({
      order_number: numRes,
      user_id: data.user_id,
      username: data.username,
      items: data.items,
      total_kop: data.total_kop,
      landmark: data.landmark,
      car: data.car,
      payment_method: data.payment_method,
      status: "new",
    })
    .select("*")
    .single();

  if (insErr || !inserted) {
    throw new Error(`createOrder insert failed: ${insErr?.message ?? "no row"}`);
  }
  return inserted as OrderRow;
}

/**
 * Обновить статус заказа и (опционально) записать, кто из курьеров нажал кнопку.
 */
export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  handledBy?: string
): Promise<void> {
  const patch: { status: OrderStatus; handled_by?: string } = { status };
  if (handledBy !== undefined) patch.handled_by = handledBy;

  const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
  if (error) {
    throw new Error(`updateOrderStatus failed: ${error.message}`);
  }
}

/**
 * Записать message_id карточки в admin-чате (для последующего editMessageText).
 * Отдельная функция — вызывается сразу после успешной отправки карточки.
 */
export async function setOrderAdminMessageId(
  orderId: string,
  adminMessageId: number
): Promise<void> {
  const { error } = await supabase
    .from("orders")
    .update({ admin_message_id: adminMessageId })
    .eq("id", orderId);
  if (error) {
    throw new Error(`setOrderAdminMessageId failed: ${error.message}`);
  }
}

/** Прочитать заказ по id (для admin-callback'ов смены статуса). */
export async function getOrderById(orderId: string): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    throw new Error(`getOrderById failed: ${error.message}`);
  }
  return (data as OrderRow | null) ?? null;
}

// ============================================================================
// app_settings (admin_chat_id)
// ============================================================================

/**
 * Прочитать admin_chat_id из app_settings. Значение хранится как TEXT (в БД —
 * `value TEXT`), в коде — bigint. Если не задан — null.
 */
export async function getAdminChatId(): Promise<bigint | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "admin_chat_id")
    .maybeSingle();

  if (error) {
    throw new Error(`getAdminChatId failed: ${error.message}`);
  }
  if (!data?.value) return null;
  try {
    return BigInt(data.value);
  } catch {
    console.warn("admin_chat_id parse failed", { value: data.value });
    return null;
  }
}

/**
 * Записать admin_chat_id. Singleton: используем UPSERT по PK 'admin_chat_id'.
 */
export async function setAdminChatId(chatId: number): Promise<void> {
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: "admin_chat_id",
      value: chatId.toString(),
    },
    { onConflict: "key" }
  );
  if (error) {
    throw new Error(`setAdminChatId failed: ${error.message}`);
  }
}

// ============================================================================
// demand_clicks
// ============================================================================

/**
 * Атомарный инкремент счётчика спроса на позицию по slug (RPC bump_demand).
 * Без read-modify-write в JS — иначе гонка при параллельных апдейтах.
 */
export async function bumpDemand(slug: string, title: string): Promise<void> {
  const { error } = await supabase.rpc("bump_demand", {
    p_slug: slug,
    p_title: title,
  });
  if (error) {
    throw new Error(`bumpDemand RPC failed: ${error.message}`);
  }
}

// ============================================================================
// /стат — дневная сводка (Europe/Moscow)
// ============================================================================

/**
 * Ключ payment для локальной агрегации.
 */
const PAYMENT_KEYS: PaymentMethod[] = ["sbp", "cash", "terminal"];

/**
 * Границы «сегодня» в Europe/Moscow, приведённые к UTC (для сравнения с
 * created_at TIMESTAMPTZ). Возвращаем ISO-строки.
 *
 * Подход: берём текущий момент, форматируем в компоненты MSK (offset +03:00),
 * собираем полночь MSK и полночь MSK + 1 сутки.
 *
 * Europe/Moscow — фиксированный UTC+3 без DST с 2011 года, так что просто
 * прибавляем 3 часа к UTC-полуночи и решаем от там же.
 */
function moscowTodayRange(): { fromIso: string; toIso: string } {
  const now = new Date();
  // Смещаем «сейчас» в MSK, чтобы вычислить локальную дату (Y-M-D в MSK).
  const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = mskNow.getUTCFullYear();
  const m = mskNow.getUTCMonth();
  const d = mskNow.getUTCDate();

  // Полночь MSK текущих суток → это (Y-M-D 00:00 MSK) = (Y-M-D-1 21:00 UTC).
  const startUtc = Date.UTC(y, m, d) - 3 * 60 * 60 * 1000;
  const endUtc = startUtc + 24 * 60 * 60 * 1000;

  return {
    fromIso: new Date(startUtc).toISOString(),
    toIso: new Date(endUtc).toISOString(),
  };
}

/**
 * Агрегированная сводка за сегодня по МСК.
 *
 * Из orders берём только не cancelled. Топ позиций собираем в коде из
 * items JSONB — на MVP-объёмах (десятки заказов в день) это дешевле, чем
 * тащить SQL с jsonb_array_elements.
 */
export async function getDailyStats(): Promise<DailyStats> {
  const { fromIso, toIso } = moscowTodayRange();

  const { data: orders, error: ordErr } = await supabase
    .from("orders")
    .select("total_kop,payment_method,items,status")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .neq("status", "cancelled");

  if (ordErr) {
    throw new Error(`getDailyStats orders failed: ${ordErr.message}`);
  }

  const byPayment: Record<PaymentMethod, number> = { sbp: 0, cash: 0, terminal: 0 };
  const itemsAgg = new Map<string, { title: string; qty: number }>();
  let count = 0;
  let totalKop = 0;

  for (const row of (orders ?? []) as Array<{
    total_kop: number;
    payment_method: PaymentMethod;
    items: CartItem[];
    status: OrderStatus;
  }>) {
    count += 1;
    totalKop += row.total_kop;
    if (PAYMENT_KEYS.includes(row.payment_method)) {
      byPayment[row.payment_method] += row.total_kop;
    }
    // Топ позиций из JSONB-снапшота корзины.
    const items = Array.isArray(row.items) ? row.items : [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const slug = typeof it.slug === "string" ? it.slug : null;
      const title = typeof it.title === "string" ? it.title : null;
      const qty = typeof it.qty === "number" ? it.qty : 0;
      if (!slug || !title || qty <= 0) continue;
      const prev = itemsAgg.get(slug);
      if (prev) {
        prev.qty += qty;
      } else {
        itemsAgg.set(slug, { title, qty });
      }
    }
  }

  const topItems = [...itemsAgg.values()]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const { data: demand, error: demErr } = await supabase
    .from("demand_clicks")
    .select("title,clicks")
    .order("clicks", { ascending: false })
    .limit(10);

  if (demErr) {
    throw new Error(`getDailyStats demand failed: ${demErr.message}`);
  }

  const topDemand = ((demand ?? []) as Array<{ title: string; clicks: number }>).map(
    (r) => ({ title: r.title, clicks: r.clicks })
  );

  return {
    count,
    total_kop: totalKop,
    by_payment: byPayment,
    top_items: topItems,
    top_demand: topDemand,
  };
}
