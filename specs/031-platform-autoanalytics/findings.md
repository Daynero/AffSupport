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

## Catalog empty claims — 2026-11-05

The reported attempt remained queued with no operation or lease; the supplied
native checkpoint later recorded `settled` with a null operation and reason.
The worker code proves this can represent an empty broker response, not completed
video processing. Existing production projections do not retain the exact claim
exclusion predicate. The historical incident cause remains unproven.

Three independent defects were reproduced before their fix: removing a retired
copy erased the receipt needed to allow the next job; two authorized native
delegations excluded each other; Stop removed the job pointer needed to expire an
unexecuted handoff. New durable markers preserve observed output and renewed
handoff authority. Member claims serialize before eligibility checks. Expired
handoffs can be recovered by another authorized member only without execution,
upload or provider-result evidence; unknown metadata remains blocked.

Diagnostics now expose current shared eligibility predicates, not reconstructed
history. Native empty responses are sampled every five minutes at most and pass
through the existing privacy and ingestion seams. Missing output evidence uses
the existing result-uncertain profile error. Production was not changed. Packaged
beta, simultaneous native acceptance and after-release user delivery remain
unverified; T035 records those boundaries.

Local PostgreSQL verification: `SOTY_TEST_DB_SOURCE_PROJECT=r2beta045 npm run
test:db` passed all 1064 pgTAP assertions, two real Auth checks and 37 native
PostgreSQL tests. The new deterministic concurrent-connection test holds the
first claim transaction open while a second authorized installation requests a
different queued catalog; exactly one member lease is issued. The native fixture
replays the full migration chain, including the catalog-history lookup index.
Only schema and role definitions were cloned; no production or existing local
application rows were changed. Packaged two-agent end-to-end execution remains
separate from this verified SQL concurrency boundary.

Final verification of the local patch (2026-11-05): `npm run verify` passed
14/14 gates; 8603 tests passed, 50 environment or platform opt-ins were skipped,
and no tests failed. The final `test:db` rerun with the same local source project
passed all 1064 pgTAP checks plus 39 native PostgreSQL and Auth tests. The final
migration includes visible uncertainty for legacy orphaned, reserved, uploading
and advanced-stage expired operations; those operations remain fenced from replay.
The disposable test containers were cleaned up. No production release, production
repair or packaged-beta acceptance was performed.

## Owner report: off → update → on → update workaround

Users report that disabling restitch, updating, enabling restitch and updating
again sometimes succeeds. Two additional SQL regressions reproduce the relevant
mechanics: a new attempt with restitch disabled can deliver a catalog without a
replacement video, and enabling it for the next attempt queues video preparation;
changing the profile after a manual attempt is accepted does not erase that
attempt's frozen restitch requirement. The latter continues waiting for a spare.
`tests/team-catalog-restitch-sql.test.ts`: 41/41 passed after adding both cases.
These explain distinct possible outcomes of the reported workaround; no new
user-specific server evidence establishes which branch any affected user hit.
A catalog update alone is not proof that replacement video was produced, and
toggling must not clear uncertain execution or provider-output fences. This
follow-up changes regression coverage only; the previous production-release
boundary remains unchanged.

## Mixed bulk manual retries — additional confirmed defect

A mixed bulk request reset retry deadlines, attempt counters and the diagnostic
error of already-pending catalogs whenever at least one selected catalog opened
a new attempt. The regression fails against the prior function: attempts change
from 4 to 0 and RESTITCH_POOL_EMPTY disappears. The new migration captures exactly
the catalog IDs returned by the accepted-attempt UPDATE and resets preparation
only for those IDs. Already-pending and reconciliation-blocked selections retain
their state. A repeated request opening zero attempts remains a no-op.
The catalog restitch suite passes 42 tests with this patch. No assertion is made
that this independently confirmed bug explains every reported toggle workaround.

## Frozen-attempt UI after toggling restitch

The manager used the mutable next-run restitch flag to decide whether a pending
video failure needed attention and whether its details were visible. A regression
fails against the prior UI when the profile is off but the accepted run is still
in waiting_video with PROCESS_RESULT_UNCERTAIN. The manager now prioritizes the
authoritative current stage for pending runs, keeping future profile choices
unchanged. The inverse case is covered too: a building sheet is not relabeled as
waiting for next-run video merely because the profile has restitch enabled.
Existing catalog stage/error readback, result-visible and filter-count diagnostic
seams remain in use; no content or new telemetry fields are collected.

Follow-up validation: 84 focused SQL and manager UI tests passed. The database
gate passed 1064 pgTAP checks and 39 real PostgreSQL/Auth tests with migration 20261207125000. Full-suite success recorded above predates this follow-up; the
follow-up uses focused regressions plus the static and isolated database gates.
Packaged-beta acceptance and production publication remain outstanding.

## Bulk trash panels that cannot be dismissed (2026-11-05)

The owner supplied a panel with zero of ten receipts confirmed and permission
errors shown alongside unknown outcomes. The UI offered dismissal only when
every item was confirmed; its header chevron merely collapsed the panel. This
proves the missing escape action, not the provider outcome of those deletions.
A permission error alone must not rewrite an unknown receipt as failed.

Bulk trash now supplies an always-accessible, localized header hide action,
including when collapsed, using the existing receipt-preserving dismissal seam.
It neither retries nor cancels the mutation, changes receipt state, nor emits
result-visible acknowledgement. Existing confirmed-result visibility and
auto-dismiss behavior are retained. Hidden groups remain available internally
for reconciliation and overlap protection. Dismissal survives receipt refresh
within the current workspace provider; it is not persisted across reloads.
Existing workspace-operation diagnostic signals remain authoritative, with no
new user content or telemetry fields. The affected user's identity and server
receipts have not been established for this screenshot.

Validation: 38 focused explorer/workspace-operation/analytics tests and all 13
static gates passed. Coverage includes queued, running, failed, unknown and
confirmed states, closing while collapsed, no retry or extra acknowledgement,
and an unknown permission-denied group staying hidden after refresh without
mutation calls. This change is local; packaged acceptance and release remain.
