/**
 * Типы БД Queue Cat / Bubble Cat.
 *
 * Соответствуют схеме из supabase/migrations/ (0001 + 0002).
 * Правила:
 * - Денежные значения — INTEGER в копейках (250 ₽ = 25000). Никаких float.
 * - user_id в user_sessions и orders — Telegram from.id (BIGINT), НЕ FK на auth.users.
 * - orders.items — JSONB-снапшот корзины (не нормализуется в order_items).
 * - TIMESTAMPTZ приходят строкой в ISO-формате от Supabase JS.
 */

// ============================================================================
// Общие вспомогательные типы
// ============================================================================

export type SessionState =
  | 'browsing'
  | 'choosing_variant'
  | 'cart'
  | 'checkout_landmark'
  | 'checkout_landmark_text'
  | 'checkout_car'
  | 'checkout_payment';

export type PaymentMethod = 'sbp' | 'cash' | 'terminal';

export type OrderStatus = 'new' | 'in_progress' | 'delivered' | 'cancelled';

export type VariantGroup = 'syrup' | 'tea' | null;

export type DemandEventKind = 'sold_out' | 'not_carried';

export type CartItem = {
  slug: string;
  title: string;
  variant: string | null;
  price_kop: number;
  qty: number;
};

// ============================================================================
// Строки таблиц
// ============================================================================

export type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

export type MenuItemRow = {
  id: string;
  slug: string;
  title: string;
  price_kop: number;
  variant_group: VariantGroup;
  field_item: boolean;
  available: boolean;
  sort_order: number;
  stock_qty: number;
  reserved_qty: number;
  created_at: string;
  updated_at: string;
};

export type UserSessionRow = {
  user_id: number;
  username: string | null;
  state: SessionState;
  context: Record<string, unknown>;
  cart: CartItem[];
  last_car: string | null;
  ui_message_id: number | null;
  created_at: string;
  updated_at: string;
};

export type OrderRow = {
  id: string;
  order_number: number;
  user_id: number;
  username: string | null;
  items: CartItem[];
  total_kop: number;
  landmark: string;
  car: string;
  payment_method: PaymentMethod;
  status: OrderStatus;
  admin_message_id: number | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DemandEventRow = {
  id: string;
  slug: string;
  title: string;
  kind: DemandEventKind;
  user_id: number | null;
  created_at: string;
};

// ============================================================================
// Ключи app_settings
// ============================================================================

export type AppSettingKey =
  | 'admin_chat_id'
  | 'order_counter'
  | 'admin_bound_by'
  | 'waitlist_message_id'
  | 'waitlist_date';

// ============================================================================
// RPC return types
// ============================================================================

export type NextOrderNumberReturn = number;

export type ReserveStockItem = { slug: string; qty: number };
export type ReserveStockShortage = { slug: string; available: number };
export type ReserveStockResult =
  | { ok: true }
  | { ok: false; short: ReserveStockShortage[] };
