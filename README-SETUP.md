# Пакет настроек Claude Code — Queue Cat

Сгенерирован из SPEC.md по методологии AI-Архитектора. Адаптирован под реальную
форму проекта — serverless Telegram-бот, а не веб-SaaS.

## Что внутри
```
CLAUDE.md                          — главный файл проекта (в корень репозитория)
.claude/agents/
  database-architect.md            — схема БД, миграции, RPC, deny-all RLS
  telegram-bot-engineer.md         — ядро: webhook, FSM, callback-протокол, Bot API
  backend-engineer.md              — webhook-обвязка, Zod, service-role, безопасность
  qa-tester.md                     — прогон edge cases Блока 6 перед финалом
.claude/rules/
  telegram-bot.md                  — инварианты бота и serverless-состояния
  database.md                      — deny-all RLS, копейки, атомарность, TZ
  autonomous-build.md              — граница «делаю сам / выношу в README»
MCP-SETUP.md                       — команды подключения Context7 (и опц. Supabase MCP)
```

## Как разложить
1. `CLAUDE.md` → в корень репозитория проекта
2. Папку `.claude/` → в корень репозитория
3. `SPEC.md` (из прошлого шага) → в корень репозитория
4. Выполнить команды из `MCP-SETUP.md`

## Чем отличается от шаблона генератора (осознанные отклонения)
- **Нет frontend-developer** — в проекте нет React-страниц/UI, только webhook
- **Нет Части 0 (продакшн AI-агенты)** — бот не содержит LLM внутри продукта, это
  не AI-агент в смысле генератора
- **RLS = deny-all, не авторизация** — доступ к БД service-role ключом, нет Supabase Auth
- **Добавлены telegram-bot-engineer и qa-tester** — под реальную суть: FSM-бот и
  необходимость автономной проверки edge cases
- **Skills и SPEC_TEMPLATE.md не генерировались** — для одноразового MVP-бота с
  дедлайном они избыточны (шаблон фичи не нужен проекту без итеративного роста фич)

## Дальше
Финальный промпт для Claude Code (запуск автономной сборки) — генерируется отдельно
по запросу. Он свяжет SPEC.md + этот пакет и даст Claude Code команду собрать проект,
вынеся ручные шаги в README.
