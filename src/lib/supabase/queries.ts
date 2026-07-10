/**
 * Все обращения к БД проходят здесь. Server-only, использует service-role клиент.
 *
 * Принципы (SPEC.md, Блок 2 / rules/database.md):
 * - Атомарные операции — через RPC (next_order_number, decrement_stock и пр.).
 * - Заказ — снапшот корзины (JSONB), не нормализуется.
 * - «Сегодня» заменено посменным учётом: всё считается от shifts.started_at.
 * - Деньги — INTEGER в копейках. Никаких float.
 */

import { supabase } from "@/lib/supabase/client";
import type {
  CartItem,
  DemandEventReason,
  MenuItemRow,
  OrderRow,
  OrderStatus,
  PaymentMethod,
  ShiftRow,
  UserSessionRow,
} from "@/types/database";

// ============================================================================
// Служебные типы
// ============================================================================

export type CreateOrderData = {
  user_id: number;
  username: string | null;
  items: CartItem[];
  total_kop: number;
  landmark: string;
  car: string;
  payment_method: PaymentMethod;
  shift_id: string;
};

export type ShiftStats = {
  shiftId: string;
  startedAt: string;
  count: number;
  total_kop: number;
  by_payment: Record<PaymentMethod, number>;
  top_items: Array<{ title: string; qty: number }>;
  stock: Array<{ slug: string; title: string; stock: number }>;
  waited_sold_out: Array<{ title: string; count: number }>;
  wanted_not_carried: Array<{ title: string; count: number }>;
};

export type WaitlistInfo = { message_id: number; date: string } | null;

// ============================================================================
// user_sessions
// ============================================================================

export async function getOrCreateSession(
  userId: number,
  username?: string
): Promise<UserSessionRow> {
  const { data: existing, error: readErr } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (readErr) {
    throw new Error(`getOrCreateSession read failed: ${readErr.message}`);
  }

  if (existing) {
    if (username !== undefined && existing.username !== username) {
      const { error: updErr } = await supabase
        .from("user_sessions")
        .update({ username })
        .eq("user_id", userId);
      if (updErr) {
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

export async function saveSession(session: UserSessionRow): Promise<void> {
  const { error } = await supabase
    .from("user_sessions")
    .update({
      username: session.username,
      state: session.state,
      context: session.context,
      cart: session.cart,
      last_car: session.last_car,
      live_message_id: session.live_message_id,
    })
    .eq("user_id", session.user_id);

  if (error) {
    throw new Error(`saveSession failed: ${error.message}`);
  }
}

// ============================================================================
// menu_items
// ============================================================================

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

  const next = !(current as { available: boolean }).available;
  const { error: updErr } = await supabase
    .from("menu_items")
    .update({ available: next })
    .eq("slug", slug);

  if (updErr) {
    throw new Error(`toggleAvailability update failed: ${updErr.message}`);
  }
  return next;
}

/**
 * Adjust stock by delta (clamped to >= 0).
 * Returns new qty and whether the decrement was blocked at zero.
 */
export async function updateStockQty(
  slug: string,
  delta: number
): Promise<{ newQty: number; clamped: boolean }> {
  const { data, error: readErr } = await supabase
    .from("menu_items")
    .select("stock")
    .eq("slug", slug)
    .maybeSingle();

  if (readErr || !data) {
    throw new Error(`updateStockQty read failed: ${readErr?.message ?? "no row"}`);
  }

  const current = (data as { stock: number }).stock;
  const clamped = delta < 0 && current === 0;
  const newQty = Math.max(0, current + delta);

  const { error: updErr } = await supabase
    .from("menu_items")
    .update({ stock: newQty })
    .eq("slug", slug);

  if (updErr) {
    throw new Error(`updateStockQty update failed: ${updErr.message}`);
  }
  return { newQty, clamped };
}

// ============================================================================
// orders
// ============================================================================

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
      shift_id: data.shift_id,
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
 * Update order status with a graph guard to prevent double-processing.
 * Returns { updated: true } if the transition happened, { updated: false } if
 * the order was already in a terminal/wrong state.
 */
export async function updateOrderStatusGuarded(
  orderId: string,
  status: OrderStatus,
  handledBy?: string
): Promise<{ updated: boolean }> {
  const allowedFrom: Partial<Record<OrderStatus, OrderStatus[]>> = {
    in_progress: ["new"],
    delivered: ["in_progress"],
    cancelled: ["new", "in_progress"],
  };
  const allowed = allowedFrom[status];
  if (!allowed || allowed.length === 0) return { updated: false };

  const patch: { status: OrderStatus; handled_by?: string } = { status };
  if (handledBy !== undefined) patch.handled_by = handledBy;

  const { data, error } = await supabase
    .from("orders")
    .update(patch)
    .eq("id", orderId)
    .in("status", allowed)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`updateOrderStatusGuarded failed: ${error.message}`);
  }
  return { updated: data !== null };
}

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

/** Последние N заказов клиента для экрана истории. */
export async function getRecentOrders(
  userId: number,
  limit = 3
): Promise<OrderRow[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("order_number,items,total_kop,status,created_at,id,user_id,username,landmark,car,payment_method,shift_id,admin_message_id,handled_by,updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getRecentOrders failed: ${error.message}`);
  }
  return (data ?? []) as OrderRow[];
}

/**
 * Получить заказ по номеру, только если он принадлежит этому userId.
 * Защита от подделки callback_data (Edge Case 7 FEATURE_SPEC_05).
 */
export async function getOrderByNumberAndUser(
  orderNumber: number,
  userId: number
): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("order_number", orderNumber)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`getOrderByNumberAndUser failed: ${error.message}`);
  }
  return (data as OrderRow | null) ?? null;
}

// ============================================================================
// app_settings
// ============================================================================

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
    return BigInt((data as { value: string }).value);
  } catch {
    console.warn("admin_chat_id parse failed", { value: (data as { value: string }).value });
    return null;
  }
}

export async function setAdminChatId(chatId: number): Promise<void> {
  const { error } = await supabase.from("app_settings").upsert(
    { key: "admin_chat_id", value: chatId.toString() },
    { onConflict: "key" }
  );
  if (error) {
    throw new Error(`setAdminChatId failed: ${error.message}`);
  }
}

export async function getWaitlistInfo(): Promise<WaitlistInfo> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key,value")
    .in("key", ["waitlist_message_id", "waitlist_date"]);

  if (error) {
    throw new Error(`getWaitlistInfo failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{ key: string; value: string }>;
  const msgId = rows.find((r) => r.key === "waitlist_message_id")?.value;
  const date = rows.find((r) => r.key === "waitlist_date")?.value;

  if (!msgId || !date) return null;
  const messageId = Number(msgId);
  if (!Number.isFinite(messageId)) return null;
  return { message_id: messageId, date };
}

export async function setWaitlistInfo(messageId: number, date: string): Promise<void> {
  const { error } = await supabase.from("app_settings").upsert(
    [
      { key: "waitlist_message_id", value: String(messageId) },
      { key: "waitlist_date", value: date },
    ],
    { onConflict: "key" }
  );
  if (error) {
    throw new Error(`setWaitlistInfo failed: ${error.message}`);
  }
}

// ============================================================================
// demand_events
// ============================================================================

/**
 * Записывает событие спроса через RPC bump_demand.
 * reason: 'sold_out' — позиция закончилась; 'unavailable' — снята или не в каталоге.
 */
export async function recordDemandEvent(
  slug: string,
  title: string,
  userId: number,
  reason: DemandEventReason
): Promise<void> {
  const { error } = await supabase.rpc("bump_demand", {
    p_slug: slug,
    p_title: title,
    p_user_id: userId,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`recordDemandEvent (bump_demand) failed: ${error.message}`);
  }
}

// ============================================================================
// processed_updates — дедупликация Telegram webhook ретраев
// ============================================================================

/**
 * Вставляет update_id в журнал.
 * Возвращает true если апдейт новый, false если дубликат (уже обрабатывался).
 * При ошибке БД: fail-open (возвращает true) чтобы не терять апдейты.
 */
export async function insertProcessedUpdate(updateId: number): Promise<boolean> {
  const { error } = await supabase
    .from("processed_updates")
    .insert({ update_id: updateId });

  if (error) {
    if (error.code === "23505") {
      return false; // duplicate key — already processed
    }
    // DB unavailable — fail-open, process the update anyway
    console.error("processed_updates_insert_failed", {
      update_id: updateId,
      error: error.message,
    });
    return true;
  }
  return true;
}

// ============================================================================
// shifts
// ============================================================================

export async function getCurrentShift(): Promise<ShiftRow | null> {
  const { data, error } = await supabase
    .from("shifts")
    .select("*")
    .is("ended_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`getCurrentShift failed: ${error.message}`);
  }
  return (data as ShiftRow | null) ?? null;
}

/** Возвращает возраст смены в часах (дробное). */
export function getShiftAgeHours(shift: ShiftRow): number {
  return (Date.now() - new Date(shift.started_at).getTime()) / (1000 * 60 * 60);
}

/** Открывает новую смену через RPC (закрывает старую + сбрасывает остатки). */
export async function startShift(startedBy: string): Promise<string> {
  const { data, error } = await supabase.rpc("start_shift", {
    p_started_by: startedBy,
  });
  if (error) {
    throw new Error(`start_shift RPC failed: ${error.message}`);
  }
  return data as string;
}

// ============================================================================
// Stock RPCs
// ============================================================================

function aggregateBySlug(items: CartItem[]): Array<{ slug: string; qty: number }> {
  const bySlug = new Map<string, number>();
  for (const item of items) {
    bySlug.set(item.slug, (bySlug.get(item.slug) ?? 0) + item.qty);
  }
  return [...bySlug.entries()].map(([slug, qty]) => ({ slug, qty }));
}

/**
 * Возвращает остатки после сбоя createOrder (роллбэк).
 * Используется только в редком пути ошибки — read-modify-write здесь допустим.
 */
export async function returnStock(items: CartItem[]): Promise<void> {
  const bySlug = aggregateBySlug(items);
  for (const { slug, qty } of bySlug) {
    const { data, error: readErr } = await supabase
      .from("menu_items")
      .select("stock")
      .eq("slug", slug)
      .maybeSingle();
    if (readErr || !data) continue;
    const current = (data as { stock: number }).stock;
    await supabase
      .from("menu_items")
      .update({ stock: current + qty })
      .eq("slug", slug);
  }
}

/**
 * Атомарное списание остатков через RPC decrement_stock.
 * При нехватке бросает ошибку вида "insufficient_stock:slug1,slug2".
 * Вызывающий код должен поймать её и обработать (Edge Case 1).
 */
export async function decrementStock(items: CartItem[]): Promise<void> {
  const p_items = aggregateBySlug(items);
  const { error } = await supabase.rpc("decrement_stock", {
    p_items: JSON.stringify(p_items),
  });
  if (error) {
    // Пробрасываем как есть — в message будет "insufficient_stock:..."
    throw new Error(error.message);
  }
}

/**
 * Отмена заказа через RPC cancel_order.
 * Возвращает false если заказ уже отменён/доставлен (идемпотентно).
 * Возврат остатка происходит только если заказ принадлежит текущей смене.
 */
export async function cancelOrder(
  orderId: string,
  handledBy: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("cancel_order", {
    p_order_id: orderId,
    p_handled_by: handledBy,
  });
  if (error) {
    throw new Error(`cancel_order RPC failed: ${error.message}`);
  }
  return data as boolean;
}

// ============================================================================
// /стат — посменная сводка
// ============================================================================

const PAYMENT_KEYS: PaymentMethod[] = ["sbp", "cash", "terminal"];

export async function getShiftStats(shiftId: string): Promise<ShiftStats> {
  const shift = await getCurrentShift();

  // Orders in this shift (excluding cancelled)
  const { data: orders, error: ordErr } = await supabase
    .from("orders")
    .select("total_kop,payment_method,items,status")
    .eq("shift_id", shiftId)
    .neq("status", "cancelled");

  if (ordErr) {
    throw new Error(`getShiftStats orders failed: ${ordErr.message}`);
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
    const rowItems = Array.isArray(row.items) ? row.items : [];
    for (const it of rowItems) {
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

  // Current stock
  const { data: stockData, error: stockErr } = await supabase
    .from("menu_items")
    .select("slug,title,stock")
    .eq("field_item", true)
    .order("sort_order", { ascending: true });

  if (stockErr) {
    throw new Error(`getShiftStats stock failed: ${stockErr.message}`);
  }

  const stock = (stockData ?? []) as Array<{ slug: string; title: string; stock: number }>;

  // Demand events for this shift
  const { data: demandData, error: demErr } = await supabase
    .from("demand_events")
    .select("title,reason")
    .eq("shift_id", shiftId);

  if (demErr) {
    throw new Error(`getShiftStats demand failed: ${demErr.message}`);
  }

  const soldOutAgg = new Map<string, number>();
  const unavailableAgg = new Map<string, number>();

  for (const row of (demandData ?? []) as Array<{ title: string; reason: string }>) {
    if (row.reason === "sold_out") {
      soldOutAgg.set(row.title, (soldOutAgg.get(row.title) ?? 0) + 1);
    } else if (row.reason === "unavailable") {
      unavailableAgg.set(row.title, (unavailableAgg.get(row.title) ?? 0) + 1);
    }
  }

  const waited_sold_out = [...soldOutAgg.entries()]
    .map(([title, c]) => ({ title, count: c }))
    .sort((a, b) => b.count - a.count);

  const wanted_not_carried = [...unavailableAgg.entries()]
    .map(([title, c]) => ({ title, count: c }))
    .sort((a, b) => b.count - a.count);

  return {
    shiftId,
    startedAt: shift?.started_at ?? new Date().toISOString(),
    count,
    total_kop: totalKop,
    by_payment: byPayment,
    top_items: topItems,
    stock,
    waited_sold_out,
    wanted_not_carried,
  };
}

/** Кончившиеся позиции за текущую смену (для табло ожидания). */
export async function getDemandSoldOutCurrentShift(): Promise<
  Array<{ title: string; count: number }>
> {
  const shift = await getCurrentShift();
  if (!shift) return [];

  const { data, error } = await supabase
    .from("demand_events")
    .select("title")
    .eq("reason", "sold_out")
    .eq("shift_id", shift.id);

  if (error) {
    throw new Error(`getDemandSoldOutCurrentShift failed: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ title: string }>) {
    counts.set(row.title, (counts.get(row.title) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
}

/** Спрос за всё время, агрегированный по title+reason. */
export async function getAllTimeDemand(): Promise<
  Array<{ title: string; count: number; reason: string }>
> {
  const { data, error } = await supabase
    .from("demand_events")
    .select("title,reason");

  if (error) {
    throw new Error(`getAllTimeDemand failed: ${error.message}`);
  }

  const agg = new Map<string, { title: string; count: number; reason: string }>();
  for (const row of (data ?? []) as Array<{ title: string; reason: string }>) {
    const key = `${row.reason}:${row.title}`;
    const prev = agg.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      agg.set(key, { title: row.title, count: 1, reason: row.reason });
    }
  }
  return [...agg.values()].sort((a, b) => b.count - a.count);
}
