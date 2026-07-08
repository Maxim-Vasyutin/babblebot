/**
 * Supabase service-role клиент. SERVER-ONLY.
 *
 * Правила (SPEC.md, Блок 5 / rules/database.md):
 * - Публичного anon/browser клиента НЕ создаём — фронта нет.
 * - Ключи — только из env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * - Service-role обходит RLS штатно; RLS на таблицах остаётся deny-all
 *   как defense-in-depth.
 *
 * Инициализация ленивая: не падаем на этапе билда, если env-переменные не
 * заданы. Проверка происходит при первом реальном обращении (webhook на
 * Vercel уже имеет env).
 */

// NB: этот модуль server-only по контракту. Пакет `server-only` в deps
// отсутствует — при желании добавить и раскомментировать импорт.
// import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

function build(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Прокси-объект: возвращает singleton service-role клиент, создавая его при
 * первом обращении. Между вызовами serverless-функции модуль может
 * переиспользоваться (Vercel держит warm-инстансы) — клиент создаётся
 * один раз на инстанс.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    if (!cached) cached = build();
    return Reflect.get(cached as object, prop, receiver);
  },
});
