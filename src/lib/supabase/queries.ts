/**
 * Все обращения к БД проходят здесь. Server-only, использует service-role клиент.
 *
 * Принципы (SPEC.md, Блок 2 / rules/database.md):
 * - Атомарные операции — через RPC (next_order_number, reserve_stock и пр.).
 * - Заказ — снапшот корзины (JSONB), не нормализуется.
 * - «Сегодня» в отчётах — Europe/Moscow, а не UTC.
 * - Деньги — INTEGER в копейках. Никаких float.
 */

import { supabase } from "@/lib/supabase/client";
import type {
  CartItem,
  DemandEventKind,
  MenuItemRow,
  OrderRow,
  OrderStatus,
  PaymentMethod,
  ReserveStockResult,
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
};

export type DailyStats = {
  count: number;
  total_kop: number;
  by_payment: Record<PaymentMethod, number>;
  top_items: Array<{ title: string; qty: number }>;
  stock: Array<{ slug: string; title: string; stock_qty: number; reserved_qty: number }>;
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
 * Adjust stock_qty by delta (clamped to >= 0).
 * Returns new qty and whether the decrement was blocked at zero.
 */
export async function updateStockQty(
  slug: string,
  delta: number
): Promise<{ newQty: number; clamped: boolean }> {
  const { data, error: readErr } = await supabase
    .from("menu_items")
    .select("stock_qty")
    .eq("slug", slug)
    .maybeSingle();

  if (readErr || !data) {
    throw new Error(`updateStockQty read failed: ${readErr?.message ?? "no row"}`);
  }

  const current = (data as { stock_qty: number }).stock_qty;
  const clamped = delta < 0 && current === 0;
  const newQty = Math.max(0, current + delta);

  const { error: updErr } = await supabase
    .from("menu_items")
    .update({ stock_qty: newQty })
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

export async function recordDemandEvent(
  slug: string,
  title: string,
  kind: DemandEventKind,
  userId: number
): Promise<void> {
  const { error } = await supabase
    .from("demand_events")
    .insert({ slug, title, kind, user_id: userId });
  if (error) {
    throw new Error(`recordDemandEvent failed: ${error.message}`);
  }
}

export async function getDemandEventsToday(
  kind: DemandEventKind
): Promise<Array<{ title: string; count: number }>> {
  const { fromIso, toIso } = moscowTodayRange();
  const { data, error } = await supabase
    .from("demand_events")
    .select("title")
    .eq("kind", kind)
    .gte("created_at", fromIso)
    .lt("created_at", toIso);

  if (error) {
    throw new Error(`getDemandEventsToday failed: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ title: string }>) {
    counts.set(row.title, (counts.get(row.title) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
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

export async function reserveStock(items: CartItem[]): Promise<ReserveStockResult> {
  const p_items = aggregateBySlug(items);
  const { data, error } = await supabase.rpc("reserve_stock", { p_items });
  if (error) {
    throw new Error(`reserve_stock RPC failed: ${error.message}`);
  }
  const result = data as { ok: boolean; short?: Array<{ slug: string; available: number }> };
  if (!result.ok) {
    return { ok: false, short: result.short ?? [] };
  }
  return { ok: true };
}

export async function releaseReserved(items: CartItem[]): Promise<void> {
  const p_items = aggregateBySlug(items);
  const { error } = await supabase.rpc("release_reserved", { p_items });
  if (error) {
    throw new Error(`release_reserved RPC failed: ${error.message}`);
  }
}

export async function returnReserved(items: CartItem[]): Promise<void> {
  const p_items = aggregateBySlug(items);
  const { error } = await supabase.rpc("return_reserved", { p_items });
  if (error) {
    throw new Error(`return_reserved RPC failed: ${error.message}`);
  }
}

// ============================================================================
// /стат — дневная сводка (Europe/Moscow)
// ============================================================================

const PAYMENT_KEYS: PaymentMethod[] = ["sbp", "cash", "terminal"];

function moscowTodayRange(): { fromIso: string; toIso: string } {
  const now = new Date();
  const mskNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = mskNow.getUTCFullYear();
  const m = mskNow.getUTCMonth();
  const d = mskNow.getUTCDate();

  const startUtc = Date.UTC(y, m, d) - 3 * 60 * 60 * 1000;
  const endUtc = startUtc + 24 * 60 * 60 * 1000;

  return {
    fromIso: new Date(startUtc).toISOString(),
    toIso: new Date(endUtc).toISOString(),
  };
}

export async function getDailyStats(): Promise<DailyStats> {
  const { fromIso, toIso } = moscowTodayRange();

  // Orders
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
    .select("slug,title,stock_qty,reserved_qty")
    .eq("field_item", true)
    .order("sort_order", { ascending: true });

  if (stockErr) {
    throw new Error(`getDailyStats stock failed: ${stockErr.message}`);
  }

  const stock = (stockData ?? []) as Array<{
    slug: string;
    title: string;
    stock_qty: number;
    reserved_qty: number;
  }>;

  // Demand events for today
  const { data: demandData, error: demErr } = await supabase
    .from("demand_events")
    .select("title,kind")
    .gte("created_at", fromIso)
    .lt("created_at", toIso);

  if (demErr) {
    throw new Error(`getDailyStats demand failed: ${demErr.message}`);
  }

  const soldOutAgg = new Map<string, number>();
  const notCarriedAgg = new Map<string, number>();

  for (const row of (demandData ?? []) as Array<{ title: string; kind: string }>) {
    if (row.kind === "sold_out") {
      soldOutAgg.set(row.title, (soldOutAgg.get(row.title) ?? 0) + 1);
    } else if (row.kind === "not_carried") {
      notCarriedAgg.set(row.title, (notCarriedAgg.get(row.title) ?? 0) + 1);
    }
  }

  const waited_sold_out = [...soldOutAgg.entries()]
    .map(([title, count2]) => ({ title, count: count2 }))
    .sort((a, b) => b.count - a.count);

  const wanted_not_carried = [...notCarriedAgg.entries()]
    .map(([title, count2]) => ({ title, count: count2 }))
    .sort((a, b) => b.count - a.count);

  return {
    count,
    total_kop: totalKop,
    by_payment: byPayment,
    top_items: topItems,
    stock,
    waited_sold_out,
    wanted_not_carried,
  };
}
