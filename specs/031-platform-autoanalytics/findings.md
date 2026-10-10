# Findings: 031 — агентна автоаналітика платформи

**Date**: 2026-10-10 · **Branch**: `031-platform-autoanalytics` (від `032-agent-link-recovery`)

## Що зроблено і чим доведено

| Область                           | Зміна                                                                                                                                                                                                            | Доказ                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Контракт guard-а (FR-048, SC-012) | одна таблиця правил у `events.ts` і `packages/shared/src/team/analytics.ts`; міграція `20261117100000_analytics_guard_contract.sql` додає 12 ключів, які клієнт уже слав, а guard відкидав                       | `tests/analytics-guard-contract.test.ts`: PGlite з реальним тілом найновішої міграції guard-а, дрейф в обидва боки; pgTAP написано |
| Доставка (FR-049)                 | черга 60, витіснення progress → informational → terminal, expiry 7 днів, лічильники відкинутих/витіснених/прострочених, подія `analytics_delivery_report`; відкинута сервером подія більше не повторюється тричі | `tests/analytics-delivery-report.test.ts` (12)                                                                                     |
| Envelope v3 (FR-053)              | колонки `agent_instance_id`, `agent_platform`, `attempt_id` (`20261117110000_analytics_envelope_v3.sql`); `platform` у health агента; `AgentContext` передає instanceId і платформу                              | `tests/link-owner.test.tsx`, `tests/agent-http.test.ts`; pgTAP написано                                                            |
| `run_id`, terminal-події (FR-050) | по одній `operation_*` на job із `run_id`; `stitch_started/completed/failed`; `landing_optimization_completed/failed`; `estimate_failed`                                                                         | `tests/analytics-run-ids.test.tsx`                                                                                                 |
| Readiness (FR-051)                | `tool_ready` для транскрибації, стітчера, landing optimizer, landing preview, компресора                                                                                                                         | `tests/analytics-readiness.test.tsx`                                                                                               |
| Помилки (FR-052)                  | `error_occurred` для кожного інструмента з `<tool>:<stage>:<code>`; агент шле `CompressionJob.errorCode` із закритого списку                                                                                     | `tests/analytics-error-codes.test.ts`                                                                                              |
| Onboarding                        | `CreateSpaceWizard` стартує flow один раз на монтування                                                                                                                                                          | `tests/team-onboarding-flow.test.tsx`                                                                                              |
| Журнал агента (FR-054)            | `DiagnosticsLog`: ring 2000 / 1 MiB, атомарний файл з ротацією, privacy-fence, записи boot/shutdown/auth/stream/entitlement/spawn/picker/drop/update; `/api/diagnostics?since=&limit=`                           | `tests/agent-diagnostics-log.test.ts` (40), покриття модуля 97,65% (поріг 95% у `coverage-critical.json`)                          |
| Support bundle (FR-045)           | «Зібрати діагностику» у діалозі підтримки: показ повністю, санітизація, копіювання лише на натискання; компонент вантажиться ліниво                                                                              | `tests/diagnostics-bundle.test.tsx` (9)                                                                                            |
| CLI (FR-055, FR-056)              | реєстр 40 можливостей; `audit` (детермінований, `--write`), `inspect`, `--as-of`, `delivery_lag_ms`, `unsupported_by_producer`; `journey` з period і санітизацією                                                | 9 файлів CLI-тестів                                                                                                                |
| Retention (FR-057)                | daily-агрегати, purge 90 днів після матеріалізації, pg_cron, анонімізація installation/session при видаленні акаунта (`20261120100000_analytics_retention.sql`)                                                  | pgTAP (50), прогнано на PGlite-шимі                                                                                                |

## Зміни поведінки, які варто знати

- **Контракт CLI**: команди, що повертали масив, тепер повертають об'єкт (`data.tools`, `data.events`, `data.stages`, `data.clusters`, `data.signals`, `data.features`, `data.cohorts`), щоб мати місце для `delivery_lag_ms`. Задокументовано в `docs/ANALYTICS_CLI.md`.
- `operation_*` тепер одна подія на job, а не підсумок на знімок; `stitch_started` — одна на job, а не на натискання. Історичні й нові дані за цими подіями не порівнювати напряму.
- Кінець періоду в CLI включний (`created_at <= end`).

## Що лишається відкритим

| Пункт                                                                        | Чому                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Коди помилок транскрибації, стітчера, landing і оцінки здебільшого `unknown` | агент повертає для цих черг текст, а не код; потрібні зміни в їхніх агентських чергах   |
| `tool_ready` для панелі живлення                                             | `power` не є `AnalyticsTool`; потрібне рішення, чи розширювати перелік                  |
| `team_preview_completed` — єдина `declared_but_never_emitted`                | використовується у метриці SC-009 із 024; прибрати чи дати продюсера — рішення власника |
| `recentLinkEvents` у bundle порожній                                         | сервіс аналітики не має read-only читача черги                                          |
| pgTAP-файли не виконані у справжньому Supabase                               | немає локального стеку (Docker); SQL перевірено на PGlite                               |
| `database.types.ts` відредаговано вручну                                     | `npm run types:supabase` потребує linked-проєкту                                        |
| Quickstart §1–§4 на беті (T023)                                              | потребує бета-стеку з реальним ingest                                                   |

## Verify

`npm run verify` (fast), 2026-10-10, чотири прогони:

| Прогін | Результат                | Причина                                                                                                                         | Дія                                                                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1      | suite ✗                  | `run-state-coverage`: новий `diagnostics-log.ts` не в `coverage-critical.json`                                                  | додано з порогом 95% (фактичне покриття 97,65%)                                                           |
| 2      | suite ✗ (1 з 560 файлів) | `team-entry-create`: `SupportDialog` транзитивно імпортував клієнт агента                                                       | `DiagnosticsBundle` вантажиться ліниво                                                                    |
| 3      | suite ✗ (1 тест)         | `transcriber-extract-failure`: очікування дочірнього процесу 2 с під навантаженням                                              | окремо 3/3 зелений; не пов'язано з 031                                                                    |
| 4      | suite ✗ (1 тест)         | `two-factor-sql` «lists newest first»: сортування `created_at desc, id`, два записи в одну мить упорядковуються випадковим UUID | окремо 1 падіння з 3 без змін 031; відома нестабільність з аудиту релізу 1.2.5; не виправлено в цій гілці |

Усі інші ворота (build, format, lint, три typecheck, design-tokens, tailwind, styles, i18n, env, csp, audit) зелені в кожному прогоні; у прогоні 2 пройшли 4693 тести з 4703. Повністю зеленого `verify` для 031 немає через два нестабільні тести поза обсягом фічі.
