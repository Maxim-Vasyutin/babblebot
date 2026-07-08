# Queue Cat — Telegram-бот заказов для очередей на АЗС

## Обзор
Telegram-бот, принимающий заказы напитков и сэндвичей от водителей в очередях на
АЗС. Клиент собирает корзину в боте, указывает машину и место в очереди; заказ
карточкой прилетает в рабочий Telegram-чат заведения, курьер доставляет к машине.
Оплата при получении. Бот дополнительно собирает статистику спроса на позиции,
которых сегодня нет.

## Стек технологий
- **Runtime:** Next.js 16 (App Router), TypeScript strict — единственный API route
  работает как Telegram webhook (serverless-функция на Vercel)
- **Backend:** Supabase (PostgreSQL 15). Доступ ТОЛЬКО server-side, service-role ключ
- **Деплой:** Vercel (webhook endpoint)
- **Валидация:** Zod
- **HTTP:** нативный fetch (Node 20+)
- **НЕТ:** фронтенда, React-страниц, shadcn/ui, Tailwind, Supabase Auth, RLS-как-контур

## Ключевой архитектурный факт (читать первым)
Serverless-функция живёт ОДИН запрос. Между нажатиями кнопок памяти нет.
**Всё состояние диалога (FSM + корзина) хранится в таблице `user_sessions`**
(поля `state`, `context` JSONB, `cart` JSONB). Никакого in-memory state, никаких
глобальных переменных для сессий — они не переживут следующий вызов функции.

## Архитектура (структура папок)
```
src/
  app/
    api/telegram/route.ts   — единственный webhook endpoint (POST)
    api/health/route.ts     — healthcheck (GET)
  lib/
    telegram/
      api.ts                — вызовы Bot API (sendMessage, editMessageText, answerCallbackQuery)
      keyboards.ts          — сборка inline-клавиатур
      escape.ts             — esc() для HTML-экранирования пользовательского текста
    supabase/
      client.ts             — service-role клиент (server-only)
      queries.ts            — доступ к данным (sessions, orders, menu, demand)
    handlers/
      router.ts             — маршрутизация update → handler
      client.ts             — клиентский поток (меню, корзина, checkout FSM)
      admin.ts              — admin-поток (/init, /стоп, /стат, статусы заказов)
    fsm.ts                  — определения состояний и переходов
    schemas.ts              — Zod-схемы Telegram Update + callback_data
  types/
    database.ts             — типы Supabase (генерируются)
supabase/
  migrations/               — SQL из Блока 2 SPEC.md
```

## Правила кодирования
- TypeScript strict mode, без any
- Именование: camelCase для переменных/функций, snake_case для таблиц и колонок БД
- Один модуль = одна ответственность; файл-обработчик ≤ 200 строк, дальше декомпозиция
- Импорты: абсолютные через `@/` алиас
- Обработка ошибок: try/catch на каждом async; webhook ВСЕГДА возвращает 200
  (кроме неверного secret → 401), внутренние ошибки логируются, наружу не текут
- Пользовательский текст (машина, ориентир, username) экранировать `esc()` перед
  вставкой в HTML-сообщение

## Работа с Supabase
- Доступ только через service-role клиент в серверном коде. Публичного/anon-клиента
  НЕ создавать
- RLS включена на всех таблицах как deny-all (defense-in-depth), НЕ как контур
  авторизации. Не писать разрешающих политик для anon/authenticated
- Схема — единый SQL из SPEC.md Блок 2 (таблицы, сид меню, RPC, триггеры), кладётся
  в `supabase/migrations/`, применяется владельцем через SQL Editor
- Атомарные операции (номер заказа, инкремент спроса) — только через RPC
  (`next_order_number`, `bump_demand`), не читать-модифицировать-писать в коде

## Telegram Bot API
- Работаем на webhook (не polling). Проверка заголовка
  `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET`
- `answerCallbackQuery` вызывать для КАЖДОГО callback (в finally), иначе у клиента
  крутятся «часики»
- Смена статуса/наличия — через `editMessageText` того же сообщения, не новое
- При 429 — одна повторная попытка по `retry_after`

## Context7
Перед написанием кода с Next.js 16 App Router, Zod, Supabase JS — проверяй актуальный
API через Context7 MCP (добавляй "use context7"). App Router меняется между версиями;
route handlers, runtime-конфиг и сигнатуры проверять обязательно.

## Команды
- npm run dev — локальная разработка
- npm run build — сборка
- npm run lint — линтинг
- Установка webhook и создание Supabase-проекта — РУЧНЫЕ шаги владельца, см. README
  (Claude Code их НЕ выполняет — нужны реальные токены и аккаунты)

## Автономная сборка — граница ответственности
Claude Code пишет ВЕСЬ код, гоняет build/lint/тесты. Claude Code НЕ делает:
создание Supabase-проекта, выполнение SQL в дашборде, Vercel deploy, установку
webhook, `/init` в группе. Эти шаги выносятся чеклистом в README.md с плейсхолдерами.

## Субагенты
- **database-architect** — схема БД, миграции, RPC, deny-all RLS. Для задач с БД
- **telegram-bot-engineer** — webhook, FSM в БД, callback-протокол, Bot API. Для
  логики бота
- **backend-engineer** — route handlers, Zod-валидация, интеграция Supabase,
  безопасность вебхука. Для серверной обвязки
- **qa-tester** — прогон edge cases из Блока 6 SPEC.md, проверка граничных сценариев.
  Перед завершением сборки
