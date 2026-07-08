/**
 * Определения состояний FSM пользователя.
 *
 * Источник истины — SPEC.md, Блок 4 (карта состояний). Хранится в
 * `user_sessions.state`. Serverless-функция ничего не помнит между запросами:
 * каждый апдейт грузит сессию, выполняет переход, сохраняет обратно.
 *
 * Карта переходов (сжато):
 *   browsing ──item(с вариантом)──> choosing_variant ──var──> cart
 *   browsing ──add(без варианта)──────────────────────────────> cart
 *   cart ──checkout──> checkout_landmark
 *   checkout_landmark ──lm:text──> checkout_landmark_text
 *   checkout_landmark / checkout_landmark_text ──> (last_car? → car_same/new) → checkout_car
 *   checkout_car ──text──> checkout_payment
 *   checkout_payment ──pay:*──> (заказ) → browsing
 */

export const FSM_STATES = [
  'browsing',
  'choosing_variant',
  'cart',
  'checkout_landmark',
  'checkout_landmark_text',
  'checkout_car',
  'checkout_payment',
] as const;

export type FsmState = (typeof FSM_STATES)[number];

/** Type-guard для валидации внешнего значения (например, из БД). */
export function isFsmState(v: unknown): v is FsmState {
  return typeof v === 'string' && (FSM_STATES as readonly string[]).includes(v);
}
