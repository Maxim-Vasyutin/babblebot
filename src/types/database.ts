/**
 * Типы БД Queue Cat / Bubble Cat.
 *
 * Соответствуют схеме из supabase/migrations/0001_initial.sql
 * (SPEC.md, Блок 2 — Data Model).
 *
 * Правила:
 * - Денежные значения — INTEGER в копейках (250 ₽ = 25000). Никаких float.
 * - user_id в user_sessions и orders — Telegram from.id (BIGINT), НЕ FK на auth.users.
 * - orders.items — JSONB-снапшот корзины (не нормализуется в order_items).
 * - TIMESTAMPTZ приходят строкой в ISO-формате от Supabase JS.
 *
 * Заглушка вместо supabase gen types: реальный проект пока не подключён,
 * поэтому типы описаны вручную по единственному источнику истины — миграции.
 */

// ============================================================================
// Общие вспомогательные типы
// ============================================================================

/** Валидные состояния FSM пользователя (checkbox в БД). */
export type SessionState =
  | 'browsing'
  | 'choosing_variant'
  | 'cart'
  | 'checkout_landmark'
  | 'checkout_landmark_text'
  | 'checkout_car'
  | 'checkout_payment';

/** Способ оплаты. */
export type PaymentMethod = 'sbp' | 'cash' | 'terminal';

/** Статус заказа. */
export type OrderStatus = 'new' | 'in_progress' | 'delivered' | 'cancelled';

/** Группа вариантов позиции меню. NULL — позиция без вариантов. */
export type VariantGroup = 'syrup' | 'tea' | null;

/**
 * Строка корзины / снапшот в orders.items.
 *
 * Формат из SPEC.md, Блок 2 (см. комментарий к user_sessions).
 * Строки с одинаковым slug + variant объединяются (растёт qty).
 * Разный вариант — разные строки.
 */
export type CartItem = {
  slug: string;
  title: string;
  /** Человекочитаемое имя варианта («С сиропом», «Зелёный»); null для позиций без вариантов. */
  variant: string | null;
  price_kop: number;
  qty: number;
};

// ============================================================================
// Строки таблиц
// ============================================================================

/** app_settings — singleton key/value. */
export type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

/** menu_items — каталог позиций. */
export type MenuItemRow = {
  id: string;
  slug: string;
  title: string;
  price_kop: number;
  variant_group: VariantGroup;
  field_item: boolean;
  available: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** user_sessions — FSM-состояние диалога и корзина. Ключ — Telegram user_id. */
export type UserSessionRow = {
  user_id: number;
  username: string | null;
  state: SessionState;
  context: Record<string, unknown>;
  cart: CartItem[];
  last_car: string | null;
  created_at: string;
  updated_at: string;
};

/** orders — заказы. items — JSONB-снапшот корзины. */
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

/** demand_clicks — счётчик «хочу 👀» по позициям, которых нет в наличии. */
export type DemandClickRow = {
  slug: string;
  title: string;
  clicks: number;
  updated_at: string;
};

// ============================================================================
// Типы аргументов и возврата RPC
// ============================================================================

/** RPC next_order_number() → int. */
export type NextOrderNumberReturn = number;

/** RPC bump_demand(p_slug, p_title) → void. */
export type BumpDemandArgs = {
  p_slug: string;
  p_title: string;
};

// ============================================================================
// Ключи app_settings (для типобезопасного доступа)
// ============================================================================

export type AppSettingKey = 'admin_chat_id' | 'order_counter' | 'admin_bound_by';
