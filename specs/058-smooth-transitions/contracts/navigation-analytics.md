# Contract: аналітика навігації

Подія: `navigation_attempt_finished` (клас `progress` у черзі: часта й вибіркова, під тиском черги витісняється першою), кореляція — `flow_id`.
Поля — [data-model.md](../data-model.md#navigationattempt-у-пам'яті--одна-подія).

## Місця реєстрації

1. `apps/web/src/analytics/events.ts` — назва в `analyticsEventNames`; переліки
   `NAV_SCREENS`, `NAV_MOTIONS`, `NAV_MODES`, `NAV_SKIP_REASONS`, `NAV_FINALS`,
   `NAV_HISTORY`; типи властивостей; правила в `ANALYTICS_PROPERTY_RULES`
   (enum або number із межами: `prepare_ms` 0–60000, `skeleton_ms` 0–60000,
   `layout_shift_milli` 0–100000, `long_frame_count` 0–1000).
2. `apps/web/src/analytics/service.ts` — подія в `PROGRESS_EVENT_NAMES`.
3. `supabase/migrations/<ts>_navigation_analytics_guard.sql` — повне тіло
   `analytics_properties_are_safe_v2` з новими ключами, enum-клаузами й межами;
   `ROLLBACK.md`; pgTAP `analytics-guard-contract.test.sql` (+ `plan`).
4. `scripts/analytics/coverage-registry.ts` — `CapabilityTool` `'web'`,
   capability `web.navigation` (`start`=`terminal`=подія, `correlate: 'flow_id'`,
   `unobservable`: проблиск на рівні GPU; спроби із закритої вкладки — «невідомо»).
5. `scripts/analytics/queries.ts` — `getNavigation(period)`: розрізи за
   `nav_motion`, `nav_to_screen`, `nav_mode`, `nav_final`, `web_build_id`,
   `browser_family`, `platform`; p50/p95 `duration_ms`; частки зі заготовкою,
   зі зсувом > 50, з довгими кадрами; приклади `flow_id` нефінальних спроб;
   подія в `QUERY_EVENT_NAMES` (відсортовано).
6. `scripts/analytics/cli.ts` (`case 'navigation'`, `HELP`), `format.ts`,
   `docs/ANALYTICS_CLI.md`, `AGENTS.md`.

## Приватність

Жодних адрес, ідентифікаторів простору/файлів/завдань, назв, запитів. Лише
закриті переліки й цілі числа. Неавторизовані (публічні) сторінки подій не
шлють — це наявна поведінка `analytics.track`.
