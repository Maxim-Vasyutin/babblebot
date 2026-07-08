---
description: Инварианты Telegram-бота и serverless-состояния
globs: ["src/app/api/telegram/**", "src/lib/handlers/**", "src/lib/telegram/**", "src/lib/fsm.ts"]
---

# Инварианты бота (нарушать нельзя)

## Состояние
- FSM пользователя и корзина живут ТОЛЬКО в `user_sessions` (БД). Никакого
  in-memory хранения между апдейтами: serverless-функция умирает после ответа
- Порядок обработки: загрузить сессию по `from.id` → переход → сохранить сессию
- `/start` сбрасывает state в browsing и очищает корзину

## Bot API
- `answerCallbackQuery` для КАЖДОГО callback, в finally (иначе «часики» у клиента)
- Статусы заказов и наличие позиций — `editMessageText` того же сообщения по
  сохранённому message_id, не новое сообщение
- parse_mode = HTML; пользовательский текст (car, landmark, username) — через `esc()`
- 429 → одна повторная попытка по retry_after

## Webhook-контракт
- Всегда 200 `{ok:true}`, кроме неверного secret → 401
- Невалидный Update → 200 + лог (не ретраить)

## callback_data
- Формат `action:arg:arg`, ≤ 64 байта, короткие slug (не длинные строки)
- Валидация Zod-regex перед разбором; не матчит → игнор + answerCallbackQuery

## Безопасность потоков
- Клиент = private chat; admin = группа с chat.id == admin_chat_id
- `adm_status:*`, `adm_stop:*` — только из admin-чата
- Защита от двойного заказа: state → browsing ДО отправки в Telegram
