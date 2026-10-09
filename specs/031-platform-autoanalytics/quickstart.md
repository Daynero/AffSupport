# Quickstart: автоаналітика платформи

`uptime` перед важкими прогонами; vitest single-worker. Результати → `findings.md`.

## 0. Автоматичні перевірки

```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork=true \
  tests/analytics-guard-contract.test.ts tests/analytics-delivery-report.test.ts \
  tests/analytics-run-ids.test.tsx tests/analytics-error-codes.test.ts \
  tests/agent-diagnostics-log.test.ts tests/analytics-coverage-registry.test.ts \
  tests/analytics-audit-command.test.ts tests/analytics-inspect-command.test.ts tests/analytics-as-of.test.ts
npm run verify
```

## 1. Контракт guard-а (SC-012)

1. Додати у `events.ts` тимчасовий ключ `link_secret` → `tests/analytics-guard-contract.test.ts` червоний із назвою ключа. Прибрати.
2. `npm run analytics -- audit --period 7d --json` → `delivery.rejected` відомий (не null).

## 2. Бета, ін'єкції (SC-014…SC-016)

| # | Дія на беті | Перевірка CLI |
| --- | --- | --- |
| a | Компресор: 1 успіх, 1 скасування, 1 помилка (непідтримуваний файл) | `inspect <run_id>` показує ланцюжок до terminal; `errors` має `error_stage ≠ unknown` |
| b | Стітчер: 1 успіх, 1 помилка | те саме; `stitch_completed`/`stitch_failed` із `run_id` |
| c | Транскрибація: 1 успіх, 1 interrupted (перезапуск агента) | `inspect` показує `interrupted` |
| d | Landing optimizer: 1 успіх | `landing_optimization_completed` із `run_id` |
| e | Відкрити кожен інструмент при зупиненому агенті, потім запустити | `tool_ready{outcome:failure}` потім `success` |
| f | Підключити простір, проіндексувати | `team-workspace` storage > 0 |
| g | Вимкнути мережу на 2 хв під час роботи, увімкнути | `analytics_delivery_report` з `expired/evicted = 0`, `delivery_lag_ms.p95` > 0 |
| h | `audit --as-of <now> --write` двічі | артефакти ідентичні |

## 3. Журнал агента та bundle (FR-054)

1. `curl -H 'x-session-token: …' 'http://127.0.0.1:43140/api/diagnostics?since=0'` → `log[]` з категоріями boot/stream/auth; жодного шляху/назви/токена (grep `/Users|C:\\|token|Bearer`).
2. У вебі: Підтримка → «Зібрати діагностику» → bundle показано повністю → «Скопіювати» → `diagnostics_copied` у `journey`.

## 4. Retention (FR-057)

1. pgTAP: `analytics-retention.test.sql` — події старші за 90 днів видалені після матеріалізації; `analytics_daily_*` містить їх агрегати; delete-account анонімізує installation/session.
2. `npm run verify:release` (один процес).
