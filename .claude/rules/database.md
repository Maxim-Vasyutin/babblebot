---
description: Правила работы с БД (Supabase, service-role, без Auth)
globs: ["supabase/**", "src/lib/supabase/**", "src/types/database.ts"]
---

# Правила БД

## Доступ
- Только service-role клиент, server-only. anon/browser-клиент НЕ создавать
- Секреты (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL) — из env

## RLS — deny-all, НЕ авторизация
- RLS включена на всех таблицах, но разрешающих политик для anon/authenticated НЕТ
- НЕ писать `auth.uid() = user_id`: в проекте нет Supabase Auth и auth.users
- `orders.user_id` — это Telegram ID (BIGINT), НЕ ссылка на auth.users

## Данные
- Деньги — INTEGER в копейках (250 ₽ = 25000). Никаких float
- `orders.items` — JSONB-снапшот корзины, не нормализуем в order_items
- Схема — строго по SPEC.md Блок 2, без самодеятельных полей

## Атомарность (serverless-гонки)
- Номер заказа — только RPC `next_order_number()`
- Спрос — только RPC `bump_demand(slug, title)`
- Не делать read-modify-write счётчиков в JS

## Время
- «Сегодня» в отчётах — Europe/Moscow (`AT TIME ZONE 'Europe/Moscow'`), не UTC
