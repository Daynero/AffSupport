# Tasks: Агентна автоаналітика та діагностика платформи

**Input**: Design documents from `/specs/031-platform-autoanalytics/`

**Prerequisites**: plan.md, spec.md (зведена), research.md, data-model.md, contracts/*, quickstart.md

**Tests**: вимагаються спекою (SC-012…SC-017); у `tests/`, single-worker.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Гілка `031-platform-autoanalytics` від `032-agent-link-recovery` (після її коміту); `uptime`; базовий прогін `tests/analytics*.test.ts`, `tests/link-analytics.test.ts`.

## Phase 2: Foundation — контракт guard-а і доставка (US6, P0)

- [ ] T002 [US6] `apps/web/src/analytics/events.ts`: експортувати `ANALYTICS_PROPERTY_KEYS`, `ANALYTICS_PROPERTY_ENUMS`, `ANALYTICS_BOOLEAN_KEYS`, `ANALYTICS_NUMERIC_RANGES` з єдиного джерела, яким уже користується `sanitizeAnalyticsProperties`; те саме для `packages/shared/src/team/analytics.ts` (`TEAM_ANALYTICS_PROPERTY_KEYS`…); `npm run build -w @video-compressor/shared`.
- [ ] T003 [P] [US6] `supabase/migrations/<ts>_analytics_guard_contract.sql`: додати в `analytics_properties_are_safe_v2` ключі, які клієнт уже шле (`limit_percent`, `selection_count`, `folder_count`, `ready_count`, `unavailable_count`, `attention_reason`, `item_count`, `tile_state`, `had_agent`, `reason`, `contribution_category`, `contribution_action`) з enum/range за клієнтом; outcome `ready|failed` для `team_landing_render` → перейменувати на клієнті в `success|failure` (не розширювати enum); `ROLLBACK.md`; pgTAP.
- [ ] T004 [US6] `tests/analytics-guard-contract.test.ts`: PGlite з реальним тілом останньої міграції guard-а; для кожного ключа/enum/bool/range із T002 — accepted/rejected; додати до `verify` (переконатися, що `scripts/verify-all.mjs` підхоплює `tests/*.test.ts` без окремого списку; якщо є список — додати).
- [ ] T005 [US6] `apps/web/src/analytics/service.ts`: лічильники `rejected/evicted/expired` (за ім'ям події), черга 60, класи пріоритету витіснення (`terminal` > `informational` > `progress`), expiry 7 днів, подія `analytics_delivery_report` (ніколи не витісняється; обнулення після прийняття); `events.ts` — ім'я і ключі звіту; `tests/analytics-delivery-report.test.ts`.
- [ ] T006 [US6] `apps/web/src/team/create/CreateSpaceWizard.tsx`: `useRef(null)` + ініціалізація один раз (`if (!ref.current) ref.current = startTeamOnboardingFlow()`); тест у `tests/team-onboarding-flow.test.tsx` (один start на монтування при повторних рендерах).
- [ ] T007 [US6] `scripts/analytics/{queries,index,format,types}.ts`: `unsupported_by_producer` для сигналів без продюсера (`friction.update_not_completed` частково, `updates` після `update_started`, `onboarding` legacy-події, `features` без емітерів, `cohorts` `unknown` → `no_agent_context`); реєстр продюсерів у `coverage-registry.ts` (T013) — джерело істини; тест `tests/analytics-unsupported.test.ts`.

**Checkpoint**: `verify` червоний на будь-якому розходженні клієнт↔guard; втрати доставки видимі.

## Phase 3: Інструменти — run_id, terminal, readiness, error (US1/US5, P1)

- [ ] T008 [P] `apps/web/src/analytics/tools.ts` + `service.ts`: generic lifecycle передає `run_id` (job id) у envelope для `operation_started|completed|failed|cancelled`; `apps/web/src/stitcher/StitcherPage.tsx`: `stitch_started{run_id}` + `stitch_completed|stitch_failed{run_id}`; `landing/LandingOptimizerPage.tsx`: `landing_optimization_completed|failed{run_id}`; `App.tsx`: `estimate_failed{run_id,error_code}`; `tests/analytics-run-ids.test.tsx`.
- [ ] T009 [P] `apps/web/src/analytics/readiness.ts` (`trackToolReady`) і виклики з initial-read ефектів `TranscriptionPage`, `StitcherContext`, `LandingOptimizerPage`, `useLandingViewer`, `lib/power.tsx`, `App.tsx` (компресор); `tool_ready` у `events.ts`; тест у `tests/analytics-run-ids.test.tsx`.
- [ ] T010 [P] `error_occurred` для компресора (`analytics/compression.ts`: коди з `CompressionJob.error.code` замість regex; якщо агент не дає код — `error_code:'unknown'` + `error_stage` з job stage), транскрибації (`TranscriptionPage.handleError`), landing optimizer/preview, team process/download/restitch (`useTeamOperation`, `useRestitchDelivery`); `error_stage` enum на інструмент у `events.ts`; `tests/analytics-error-codes.test.ts`.
- [ ] T011 `packages/shared/src/types.ts` + агент: переконатися, що кожна відмова агента повертає стабільний `error`/`reason` код (вже конституційна вимога V); додати `code` у `CompressionJob.error`, якщо його немає; тести агента.

## Phase 4: Envelope v3 (FR-053)

- [ ] T012 `supabase/migrations/<ts>_analytics_envelope_v3.sql`: колонки `agent_instance_id uuid`, `agent_platform text check in (macos,windows)`, `attempt_id text` (opaque regex), індекс `attempt_id`; `ingest_analytics_events` переносить `attempt_id` з properties у колонку; RLS без змін; `npm run types:supabase`; `service.ts` — `setAgentContext({instanceId, platform})` з `AgentContext` (health `instanceId`, платформа з `platformFromAgentCapabilities` або нового поля health `platform`); `agent: /health` + `platform` (аддитивно); pgTAP + `tests/analytics.test.ts` розширення.

## Phase 5: Журнал агента і bundle (US5, FR-054, FR-045)

- [ ] T013 `apps/agent/src/server/diagnostics-log.ts`: ring buffer + атомарний `diagnostics.jsonl` (≤ 1 МБ, ротація), closed categories/codes, sanitizer (відмова на `/`, `\`, `token`, `http`); `tests/agent-diagnostics-log.test.ts` (межі, ротація, sanitizer, since/limit).
- [ ] T014 Записи у журнал: `index.ts` (boot/shutdown/exit), `server/app.ts` (auth mismatch bucket, limiter, handshake origin class), `server/sse.ts` (subscribe/evict/closeAll), `entitlement/entitlement.ts` (decision, skew bucket), `power/spawn.ts` (spawn/exit category, duration bucket, tool), `files/picker.ts` (launch/exit/cancel/visibility unknown), drop resolver (location class, outcome), queue drain; `GET /api/diagnostics?since=&limit=`; `tests/agent-http.test.ts` розширення.
- [ ] T015 Веб: `apps/web/src/support/DiagnosticsBundle.tsx` (інвентар): читає `/api/diagnostics`, `lastKnownAgent`, build, browser family, link reason, останні `link_*`; показує повністю; «Скопіювати» → `diagnostics_copied`; sanitizer-тест `tests/diagnostics-bundle.test.tsx` (без шляхів/токенів); i18n ключі.

## Phase 6: CLI — реєстр, audit, inspect, as-of, lag (US2/US3, FR-055/FR-056)

- [ ] T016 `scripts/analytics/coverage-registry.ts`: реєстр усіх можливостей (компресор, стітчер/restitch, транскрибація/переклад, landing optimizer/preview, catalog updater, простір storage/index/sync/upload/download/move/rename/delete/share, library, tasks, accounts/finance метадані, notebook, link/pairing/update (032), analytics self); `tests/analytics-coverage-registry.test.ts` (кожна подія реєстру є в `events.ts`/shared; кожна подія, яку читає CLI, є в реєстрі або позначена unsupported).
- [ ] T017 `--as-of` у `periods.ts`/`index.ts` (усі команди); `delivery_lag_ms` у кожній агрегуючій відповіді (`queries.ts` helper); `journey` з period за замовчуванням 30d і санітизацією properties клієнтським allowlist-ом; `tests/analytics-as-of.test.ts`.
- [ ] T018 `audit` (`queries.ts getAudit`, `format.ts`, `index.ts`, `--write` → `specs/031-platform-autoanalytics/analysis/<date>.json`, стабільні finding ids); `tests/analytics-audit-command.test.ts` (PGlite: covered/partial/uncovered/declared_but_never_emitted, orphan starts, unknown codes, delivery counters, uncovered builds, детермінізм при тому самому snapshot).
- [ ] T019 `inspect <id>` (`queries.ts getInspect` за `flow_id|run_id|attempt_id` у колонках і properties; стадії з реєстру; `last_proven_stage`); `tests/analytics-inspect-command.test.ts`.
- [ ] T020 `docs/ANALYTICS_CLI.md`, `AGENTS.md` (таблиця питань: «що сталося з цією операцією» → `inspect`; «де сліпі зони» → `audit`), `specs/031-platform-autoanalytics/analysis/README.md`, `.gitignore` для `analysis/*.json` окрім README.

## Phase 7: Retention (FR-057)

- [ ] T021 `supabase/migrations/<ts>_analytics_retention.sql`: `analytics_daily_tool_outcomes`, `analytics_daily_events` (RLS, grant SELECT `wishly_analytics_ro`), функція матеріалізації + purge 90 днів, розклад pg_cron (fallback: документована scheduled function у `docs/SUPABASE_SETUP.md`), delete-account анонімізація `installation_id`/`session_id`; `ROLLBACK.md`; `supabase/tests/database/analytics-retention.test.sql`; CLI `overview`/`cohorts` читають daily-агрегати для періодів > 90 днів.

## Phase 8: Verify, quickstart, handoff

- [ ] T022 `npm run format`, `npm run lint`, `npm run verify` (один процес); виправити падіння.
- [ ] T023 Quickstart §1–§4 на беті; `findings.md` з датою/білдом; `audit --write` перший артефакт; ISC/SC-012…017 відмічені з доказами.
- [ ] T024 Оновити `specs/031-platform-autoanalytics/checklists/requirements.md` (зведена версія), закрити T-пункти; коміт.
