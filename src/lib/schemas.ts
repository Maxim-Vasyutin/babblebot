/**
 * Zod-схемы для валидации входящих Telegram Update.
 *
 * Источник — SPEC.md, Блок 3 (Команды и Callback-протокол).
 *
 * Схемы намеренно нестрогие (unknown-поля не режем — .passthrough не нужен,
 * потому что мы читаем только то, что описано; лишние поля Zod по умолчанию
 * игнорирует при разборе). Мы НЕ используем .strict, чтобы не падать на новых
 * полях Telegram API.
 */

import { z } from "zod";

/** Отправитель update (message.from или callback_query.from). */
export const TgFrom = z.object({
  id: z.number().int(),
  username: z.string().optional(),
});

/** Чат — источник сообщения. */
export const TgChat = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
});

/** Сообщение. from опционален (в каналах его нет), text — тоже. */
export const TgMessage = z.object({
  message_id: z.number().int(),
  chat: TgChat,
  from: TgFrom.optional(),
  text: z.string().max(4096).optional(),
});

/** Callback query от inline-кнопки. */
export const TgCallbackQuery = z.object({
  id: z.string(),
  from: TgFrom,
  message: TgMessage.optional(),
  data: z.string().max(64).optional(),
});

/** Корневой Update. Хотя бы одно из message / callback_query должно быть, но
 *  на уровне схемы не требуем (роутер разберётся и залогирует «не наш тип»). */
export const TgUpdate = z.object({
  update_id: z.number().int(),
  message: TgMessage.optional(),
  callback_query: TgCallbackQuery.optional(),
});

/**
 * Валидация формата callback_data. Формат `action:arg1:arg2`, ≤ 64 байта.
 * Разрешаем дефис и подчёркивание в аргументах (UUID 36 симв с дефисами
 * помещается в лимит — `adm_status:<uuid>:<status>`).
 */
export const CallbackData = z.string().regex(/^[a-z_]+(:[a-zA-Z0-9_\-]+){0,2}$/);

// ============================================================================
// Инференсы типов — удобно импортировать из хендлеров
// ============================================================================

export type TgFromT = z.infer<typeof TgFrom>;
export type TgChatT = z.infer<typeof TgChat>;
export type TgMessageT = z.infer<typeof TgMessage>;
export type TgCallbackQueryT = z.infer<typeof TgCallbackQuery>;
export type TgUpdateT = z.infer<typeof TgUpdate>;
