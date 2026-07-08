/**
 * Telegram webhook endpoint. Единственный «внешний» вход в приложение.
 *
 * Контракт (SPEC.md, Блок 3):
 * - Секрет: заголовок `X-Telegram-Bot-Api-Secret-Token` должен равняться
 *   process.env.TELEGRAM_WEBHOOK_SECRET. Иначе — 401 (и НЕ обрабатываем).
 * - Тело: Zod-валидация через TgUpdate. Fail → лог + 200 (не ретраить).
 * - Ошибки в обработке НЕ пробрасываем: любой не-2xx заставит Telegram
 *   ретраить и создаст дубликаты. Всегда 200 { ok: true }, кроме 401.
 *
 * Runtime: дефолтный Node.js (нужен для service-role Supabase-клиента).
 * force-dynamic — webhook не должен кэшироваться.
 */

import { NextRequest } from "next/server";
import { routeUpdate } from "@/lib/handlers/router";
import { TgUpdate } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** Заголовок Telegram, которым Bot API пробрасывает наш secret_token. */
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Проверяем секрет ДО парсинга тела: чужой POST не должен нам ничего стоить.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    // Это конфигурационная ошибка деплоя — не должно случаться в проде.
    // Считаем «неавторизованным», чтобы не открыть endpoint нараспашку.
    console.error("webhook_secret_not_configured");
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const providedSecret = req.headers.get(SECRET_HEADER);
  if (providedSecret !== expectedSecret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2. Читаем JSON. Если тело битое — лог + 200 (Telegram не должен ретраить).
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    console.warn("webhook_bad_json", { error: String(err) });
    return Response.json({ ok: true });
  }

  // 3. Валидируем Zod-схемой. Fail → лог + 200 (не ретраить, апдейт мусорный).
  const parsed = TgUpdate.safeParse(raw);
  if (!parsed.success) {
    console.warn("webhook_zod_invalid", {
      issues: parsed.error.issues,
    });
    return Response.json({ ok: true });
  }

  const update = parsed.data;

  // 4. Отдаём в роутер. Все ошибки внутри — глотаем и логируем, наружу 200.
  try {
    await routeUpdate(update);
  } catch (err) {
    console.error("webhook_handler_error", {
      update_id: update.update_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return Response.json({ ok: true });
}
