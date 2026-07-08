/**
 * Healthcheck. Простой публичный GET для мониторинга (uptime-пинги).
 *
 * Не трогает БД и Telegram — «жив ли процесс» и всё. Если понадобится глубокая
 * проверка (ping Supabase) — вводить отдельный /api/health/deep.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ status: "ok", ts: new Date().toISOString() });
}
