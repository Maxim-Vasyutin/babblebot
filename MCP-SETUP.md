# Подключение MCP-серверов для Claude Code

Выполнить в терминале в корне проекта (создадут/дополнят `.mcp.json`).

## Context7 — актуальная документация библиотек
Нужен: сверять API Next.js 16 App Router, Zod, Supabase JS перед написанием кода.

```bash
claude mcp add context7 --scope project -- npx -y @upstash/context7-mcp
```

Использование в промптах: добавляй `use context7` к запросам про API библиотек.
Для конкретной библиотеки: `use library /supabase/supabase` или `/vercel/next.js`.

## Supabase MCP (опционально) — прямой доступ к БД
Нужен: чтобы database-architect мог выполнять и проверять SQL напрямую, а не только
писать файлы миграций. Требует personal access token Supabase.

```bash
claude mcp add supabase --scope project \
  -e SUPABASE_ACCESS_TOKEN=<твой_pat> \
  -- npx -y @supabase/mcp-server-supabase@latest --project-ref=<project_ref>
```

Замечание по автономной сборке: если хочешь, чтобы Claude Code собирал БЕЗ реального
Supabase (полностью автономно), Supabase MCP можно НЕ подключать — тогда
database-architect просто сложит миграции в `supabase/migrations/`, а ты применишь
их вручную по чеклисту README. Это чище для сценария «ушёл и вернулся к готовому».

## Проверка
```bash
claude mcp list
```

## .gitignore
Убедись, что `.mcp.json` с токенами и `.env*` (кроме `.env.example`) в `.gitignore`.
Supabase access token и bot token в репозиторий не коммитить.
