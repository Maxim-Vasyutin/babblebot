/**
 * Клиент Telegram Bot API.
 *
 * Правила (SPEC.md, Блок 3 / Блок 5):
 * - Работаем через нативный fetch, JSON-тело, parse_mode=HTML по умолчанию.
 * - Retry: при 429 читаем parameters.retry_after, ждём, одна повторная попытка.
 *   При 5xx — одна повторная через 500 мс. Дальше — лог, наружу ошибка не течёт
 *   (webhook всегда должен возвращать 200).
 * - answerCallbackQuery дёргаем в finally на каждый callback, иначе у клиента
 *   крутятся «часики».
 *
 * Токен — только из process.env.TELEGRAM_BOT_TOKEN. В коде никогда не хранится.
 */

// ============================================================================
// Публичные типы разметки (используются в keyboards и хендлерах)
// ============================================================================

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type ReplyKeyboardButton = { text: string };

export type ReplyKeyboardMarkup = {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  one_time_keyboard?: boolean;
};

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

export type SendMessageOptions = {
  reply_markup?: ReplyMarkup;
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
};

export type EditMessageTextOptions = {
  reply_markup?: ReplyMarkup;
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
};

/** Форма ответа Telegram Bot API. */
type TgApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
};

/** Строка сообщения, которую нужно уметь читать (message_id — единственное поле,
 *  которое используем — для сохранения admin_message_id). */
export type TgMessageResult = {
  message_id: number;
  chat: { id: number };
};

// ============================================================================
// Внутреннее: базовый вызов метода Bot API с retry-логикой
// ============================================================================

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // В runtime падаем понятной ошибкой; в билд-тайме env может быть пустым — но
    // сюда мы попадём только при вызове (webhook). Так что бросаем внятно.
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Универсальный вызов метода Bot API.
 * Возвращает распарсенный result или бросает ошибку. Ошибки ловятся выше —
 * наружу из webhook они всё равно превращаются в лог + 200.
 */
async function callBotApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${getToken()}/${method}`;

  const doFetch = async (): Promise<Response> => {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Для serverless не кэшируем.
      cache: "no-store",
    });
  };

  let response: Response;
  try {
    response = await doFetch();
  } catch (err) {
    // Сетевая ошибка — одна повторная попытка через 500 мс.
    console.warn("telegram_api_network_error", { method, error: String(err) });
    await sleep(500);
    response = await doFetch();
  }

  // 429: читаем retry_after и повторяем один раз.
  if (response.status === 429) {
    let retryAfter = 1;
    try {
      const body = (await response.clone().json()) as TgApiResponse<T>;
      retryAfter = body.parameters?.retry_after ?? 1;
    } catch {
      /* not JSON — ok */
    }
    console.warn("telegram_api_429", { method, retry_after: retryAfter });
    await sleep(retryAfter * 1000);
    response = await doFetch();
  }

  // 5xx: одна повторная попытка через 500 мс.
  if (response.status >= 500 && response.status < 600) {
    console.warn("telegram_api_5xx", { method, status: response.status });
    await sleep(500);
    response = await doFetch();
  }

  let body: TgApiResponse<T>;
  try {
    body = (await response.json()) as TgApiResponse<T>;
  } catch (err) {
    throw new Error(
      `telegram_api_bad_json method=${method} status=${response.status} err=${String(err)}`
    );
  }

  if (!body.ok || body.result === undefined) {
    throw new Error(
      `telegram_api_error method=${method} status=${response.status} code=${body.error_code} desc=${body.description}`
    );
  }

  return body.result;
}

// ============================================================================
// Публичные методы (используются хендлерами)
// ============================================================================

/**
 * Отправить сообщение. По умолчанию parse_mode=HTML. Пользовательский текст
 * (car, landmark, username) должен быть предварительно пропущен через esc().
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: SendMessageOptions = {}
): Promise<TgMessageResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: options.parse_mode ?? "HTML",
  };
  if (options.reply_markup) payload.reply_markup = options.reply_markup;
  if (options.disable_web_page_preview !== undefined) {
    payload.disable_web_page_preview = options.disable_web_page_preview;
  }
  return callBotApi<TgMessageResult>("sendMessage", payload);
}

/**
 * Отредактировать текст существующего сообщения (по message_id).
 * Используется для смены статуса заказа в admin-карточке и обновления
 * клавиатуры наличия в /стоп.
 */
export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  options: EditMessageTextOptions = {}
): Promise<TgMessageResult | true> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options.parse_mode ?? "HTML",
  };
  if (options.reply_markup) payload.reply_markup = options.reply_markup;
  if (options.disable_web_page_preview !== undefined) {
    payload.disable_web_page_preview = options.disable_web_page_preview;
  }
  return callBotApi<TgMessageResult | true>("editMessageText", payload);
}

/**
 * Погасить «часики» на кнопке. Обязательно на КАЖДЫЙ callback_query, желательно
 * в finally, даже если основная обработка упала.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<true> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  return callBotApi<true>("answerCallbackQuery", payload);
}

/**
 * Удалить сообщение. В MVP не используется (всё редактируем на месте), но
 * оставляем в API-модуле как готовую утилиту.
 */
export async function deleteMessage(chatId: number, messageId: number): Promise<true> {
  return callBotApi<true>("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}
