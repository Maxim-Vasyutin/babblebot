# Queue Cat — Telegram-бот заказов для очередей на АЗС

Telegram-бот принимает заказы напитков и сэндвичей от водителей в очередях на АЗС.
Клиент собирает корзину в боте, курьер доставляет к машине, оплата при получении.

## Структура проекта

```
src/
  app/
    api/telegram/route.ts      — webhook endpoint (POST)
    api/health/route.ts        — healthcheck (GET)
  lib/
    telegram/
      api.ts                   — sendMessage, editMessageText, answerCallbackQuery
      keyboards.ts             — сборка inline-клавиатур
      escape.ts                — esc() для HTML-экранирования
    supabase/
      client.ts                — service-role клиент
      queries.ts               — все запросы к БД
    handlers/
      router.ts                — маршрутизация update → handler
      client.ts                — клиентский поток (FSM)
      admin.ts                 — admin-поток (/init, /стоп, /стат, статусы)
      cart.ts                  — чистые функции корзины
      screens.ts               — отправка экранов бота
      admin_card.ts            — карточки заказов в admin-чат
      format.ts                — форматирование сумм, дат, тегов
    fsm.ts                     — определения состояний
    schemas.ts                 — Zod-схемы Telegram Update + callback_data
  types/
    database.ts                — TypeScript-типы таблиц Supabase
  __tests__/                   — юнит-тесты (Jest)
supabase/
  migrations/
    0001_initial.sql           — схема БД, сид меню, RPC, триггеры
```

## Разработка

```bash
npm install
npm run dev      # локальная разработка (Next.js dev server)
npm run build    # сборка
npm run lint     # линтинг
npm test         # юнит-тесты
```

---

## Чеклист ручного запуска (~20 минут)

> Claude Code написал весь код. Ниже — шаги, которые требуют реальных аккаунтов.
> Выполняй по порядку — каждый шаг зависит от предыдущего.

---

### Шаг 1. Создать бота в BotFather

1. Открой Telegram на телефоне или в десктопном приложении.
2. В строке поиска найди `@BotFather` и открой диалог с ним (у него синяя галочка верификации).
3. Отправь команду `/newbot`.
4. BotFather спросит **имя бота** (это то, что видят пользователи в шапке чата). Введи, например: `Bubble Cat`
5. BotFather спросит **username** (уникальный, должен заканчиваться на `bot`). Введи, например: `bubble_cat_penza_bot`
   - Если username занят — придумай другой.
6. BotFather пришлёт сообщение с токеном вида:
   ```
   Done! Use this token to access the HTTP API:
   7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   **Скопируй и сохрани этот токен** — это `TELEGRAM_BOT_TOKEN`.

> Дополнительно (опционально): можно сразу настроить аватар бота командой `/setuserpic` и описание командой `/setdescription` в BotFather.

---

### Шаг 2. Создать проект в Supabase

1. Зайди на [supabase.com](https://supabase.com) и войди в аккаунт (или зарегистрируйся — есть бесплатный план).
2. На главной странице нажми **New project**.
3. Заполни:
   - **Organization** — выбери свою организацию или создай новую.
   - **Name** — например: `queue-cat`
   - **Database Password** — придумай надёжный пароль и **сохрани его** (понадобится если будешь подключаться напрямую к БД).
   - **Region** — выбери ближайший к тебе (например: `Central EU (Frankfurt)` для России).
4. Нажми **Create new project** и подожди ~1-2 минуты, пока проект инициализируется.
5. Как только статус сменится на зелёный, перейди в **SQL Editor** (левое меню, иконка с кодом).
6. Нажми **New query** (кнопка вверху слева).
7. Открой файл `supabase/migrations/0001_initial.sql` из этого репозитория, **скопируй весь его текст** и вставь в SQL Editor.
8. Нажми кнопку **Run** (или `Ctrl+Enter`).
9. Внизу должен появиться результат `Success. No rows returned` — это нормально, так и должно быть.
   - Если появились ошибки — убедись, что вставил весь файл целиком и не пропустил начало.
10. Проверь, что таблицы создались: перейди в **Table Editor** — должны быть таблицы `menu_items`, `orders`, `user_sessions`, `app_settings`, `demand_clicks`.
11. Скопируй параметры подключения: перейди в **Settings → API** (левое меню внизу):
    - Поле **Project URL** — скопируй, это `SUPABASE_URL` (вида `https://xxxxxxxxxxx.supabase.co`)
    - В разделе **Project API keys** найди строку `service_role` и нажми **Reveal** рядом с ней. **Скопируй этот ключ** — это `SUPABASE_SERVICE_ROLE_KEY`.
    > ⚠️ `service_role` ключ обходит все политики безопасности. Никогда не публикуй его в коде, не коммить в git, не отправляй в чаты.

---

### Шаг 3. Создать Telegram-группу для сотрудников

1. В Telegram создай новую группу (кнопка «Создать группу» или «New Group»).
2. Назови её, например: `Bubble Cat — рабочий чат`
3. Добавь в группу своих сотрудников/курьеров.
4. Добавь в группу бота: нажми на название группы → **Добавить участников** → найди `@твой_bot_username` → добавь.
5. Убедись, что бот появился в списке участников группы.

---

### Шаг 4. Подготовить переменные окружения

Создай файл `.env.local` в корне проекта (рядом с `.env.example`):

```bash
# В терминале из папки проекта:
cp .env.example .env.local
```

Открой `.env.local` в редакторе и заполни все значения:

```
TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_WEBHOOK_SECRET=придумай-любую-строку-без-пробелов-например-abc123xyz
SUPABASE_URL=https://xxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
NEXT_PUBLIC_GROUP_URL=https://t.me/название_твоей_группы
NEXT_PUBLIC_MAP_URL=https://maps.app.goo.gl/твоя_ссылка_на_карту
```

Пояснения:
- `TELEGRAM_BOT_TOKEN` — токен из шага 1.
- `TELEGRAM_WEBHOOK_SECRET` — произвольная строка, которую ты придумываешь сам. Используется для защиты webhook от посторонних запросов. Например: `queuecat-secret-2024`. Запомни её — понадобится в шаге 6.
- `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` — из шага 2.
- `NEXT_PUBLIC_GROUP_URL` — публичная ссылка на Telegram-группу заведения для клиентов (не рабочий чат, а публичный канал/группа, если есть). Если нет — можно поставить `https://t.me/` пока.
- `NEXT_PUBLIC_MAP_URL` — ссылка на точку на Яндекс.Картах или Google Maps. Открой Яндекс.Карты, найди точку, нажми «Поделиться» → скопируй ссылку.

> `.env.local` не коммитится в git (он в `.gitignore`). Это правильно — там секреты.

---

### Шаг 5. Задеплоить на Vercel

#### 5.1. Залить код на GitHub

Если репозиторий ещё не на GitHub:

```bash
git init
git add .
git commit -m "initial commit"
# Создай репозиторий на github.com, затем:
git remote add origin https://github.com/твой-аккаунт/babblebot.git
git push -u origin main
```

#### 5.2. Подключить к Vercel

1. Зайди на [vercel.com](https://vercel.com) и войди (можно через аккаунт GitHub).
2. Нажми **Add New... → Project**.
3. В списке репозиториев найди `babblebot` и нажми **Import**.
4. На экране настроек:
   - **Framework Preset** — Vercel должен автоматически определить Next.js.
   - **Root Directory** — оставь пустым (`.`).
   - **Build and Output Settings** — оставь дефолтными.
5. Раскрой раздел **Environment Variables** и добавь все 6 переменных из шага 4:

   | Имя | Значение |
   |-----|---------|
   | `TELEGRAM_BOT_TOKEN` | токен из BotFather |
   | `TELEGRAM_WEBHOOK_SECRET` | строка из шага 4 |
   | `SUPABASE_URL` | URL из Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role ключ |
   | `NEXT_PUBLIC_GROUP_URL` | ссылка на группу |
   | `NEXT_PUBLIC_MAP_URL` | ссылка на карту |

6. Нажми **Deploy** и подожди ~1-2 минуты.
7. После успешного деплоя Vercel покажет URL вида `https://babblebot-xxxx.vercel.app` — **скопируй его**, это `APP_URL`.

#### 5.3. Проверить деплой

Открой в браузере `https://APP_URL/api/health` — должно ответить:
```json
{"status":"ok","ts":"2026-07-08T14:32:00.000Z"}
```
Если видишь это — приложение живо.

---

### Шаг 6. Установить webhook

Telegram нужно сообщить, куда отправлять обновления. Выполни в терминале, **подставив реальные значения**:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<APP_URL>/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Пример с реальными значениями:
```bash
curl "https://api.telegram.org/bot7123456789:AAFxxx/setWebhook?url=https://babblebot-xxxx.vercel.app/api/telegram&secret_token=queuecat-secret-2024"
```

Ожидаемый ответ:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Если пришло `{"ok":false,...}` — проверь, что токен и URL указаны правильно, без лишних пробелов.

**Проверить, что webhook установлен:**
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```
В ответе должно быть поле `"url"` с твоим URL и `"pending_update_count": 0`.

---

### Шаг 7. Включить меню команд бота

Это добавит кнопку ☰ рядом с полем ввода в диалоге с ботом — пользователи увидят /start и /menu.

Выполни в терминале, **подставив реальный токен**:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "start", "description": "🐱 Запустить / сбросить заказ"},
      {"command": "menu",  "description": "🧋 Показать меню"}
    ],
    "scope": {"type": "all_private_chats"}
  }'
```

Ожидаемый ответ: `{"ok":true,"result":true}`

---

### Шаг 8. Привязать рабочий чат

1. Открой Telegram и зайди в рабочую группу (из шага 3).
2. Отправь в группу команду: `/init`
3. Бот должен ответить: `✅ Этот чат — рабочий`

Если бот не ответил — убедись, что:
- Бот добавлен в группу как участник (шаг 3).
- Webhook установлен (шаг 6).
- В Vercel нет ошибок деплоя (вкладка **Deployments**).

---

### Шаг 9. Смоук-тест — проверить полный сценарий

1. **Клиентский поток:** Напиши боту в **личку** (не в группу): `/start`
   - Должно прийти приветствие с кнопками «🧋 Меню», «🛒 Мой заказ», «ℹ️ О нас».

2. **Меню:** Нажми «🧋 Меню»
   - Должны появиться 6 позиций (Кислый лимонад, Айс-латте, Кофе-тоник, Холодный чай, два сэндвича).

3. **Вариант:** Нажми «Айс-латте»
   - Должен появиться выбор «Без сиропа» / «С сиропом».

4. **Корзина:** Выбери вариант → нажми «✅ Оформить»
   - Должны появиться кнопки ориентира в очереди.

5. **Оформление:** Пройди шаги — ориентир → машина → оплата.

6. **Admin-карточка:** В рабочем чате должна появиться карточка заказа с кнопками «🚚 Взял», «✅ Доставлен», «❌ Отмена».

7. **Смена статуса:** Нажми «🚚 Взял» → карточка должна обновиться на месте (не новое сообщение).

8. **Статистика:** В рабочем чате отправь `/стат` → должна прийти дневная сводка.

9. **Наличие:** Отправь `/стоп` → должна появиться клавиатура с позициями меню → нажми на любую → значок должен смениться с ✅ на ⛔.

---

### Шаг 10. QR-код для флаера

1. Зайди на любой генератор QR, например [qr-code-generator.com](https://www.qr-code-generator.com/) или [qr.io](https://qr.io/).
2. Введи ссылку: `https://t.me/<bot_username>` (например: `https://t.me/bubble_cat_penza_bot`).
3. Скачай QR в высоком разрешении (PNG, минимум 1000×1000 px).
4. Напечатай на флаере/наклейке и размести у въезда на АЗС.

---

## Переменные окружения

| Переменная | Описание |
|-----------|---------|
| `TELEGRAM_BOT_TOKEN` | Токен из BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Произвольная секретная строка для защиты webhook |
| `SUPABASE_URL` | URL проекта Supabase (Settings → API → Project URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role ключ Supabase (Settings → API → service_role) |
| `NEXT_PUBLIC_GROUP_URL` | Ссылка на публичную Telegram-группу заведения для клиентов |
| `NEXT_PUBLIC_MAP_URL` | Ссылка на точку заведения на карте |

---

## Admin-команды (только в рабочем чате)

| Команда | Действие |
|---------|---------|
| `/init` | Привязать этот чат как рабочий (выполнять первым) |
| `/стоп` | Управление наличием позиций — тап переключает ✅/⛔ |
| `/стат` | Дневная сводка: заказы, выручка, разбивка по оплате, топ позиций и «хочу» |

---

## Архитектурные заметки

- **Serverless**: каждый webhook-запрос — отдельная жизнь функции. Весь FSM-стейт хранится в PostgreSQL (`user_sessions`).
- **Без фронтенда**: весь UI — диалог в Telegram.
- **RLS deny-all**: доступ к БД только через service-role ключ с сервера.
- **Атомарные счётчики**: номер заказа и статистика спроса — через PostgreSQL RPC, без гонок между serverless-инстансами.
