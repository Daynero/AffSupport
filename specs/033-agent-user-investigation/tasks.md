# Tasks: 033 — агентне розслідування користувача

## Phase 1: Setup

- [x] T001 Гілка `033-agent-user-investigation` від `031-platform-autoanalytics`.
- [x] T002 Стабілізувати нестабільні тести, що блокували verify 031: `tests/two-factor-sql.test.ts` (перший запис явно старший), `tests/transcriber-extract-failure.test.ts` (запас 15 с на старт stub-процесу).

## Phase 2: Журнал агента в базі (US2)

- [x] T003 [US2] Міграція `20261124100000_agent_journal.sql`: таблиця, RLS, RPC `ingest_agent_journal`, purge 30 днів у retention, grants для `wishly_analytics_ro`; ROLLBACK.md; pgTAP.
- [x] T004 [US2] `apps/web/src/analytics/journal-forwarder.ts` + виклики на тригерах; `apps/web/src/api/client.ts` використовує наявний `fetchAgentDiagnostics`; тест `tests/journal-forwarder.test.ts` (тригери, дебаунс, курсор, перезапуск агента, вимкнена аналітика, приватність).
- [x] T005 [US2] Тест `tests/agent-journal-ingest.test.ts` (PGlite з реальною міграцією): прийом, відкидання заборонених значень, дублікати, категорії = `DIAGNOSTIC_CATEGORIES`.

## Phase 3: Коди помилок і мапа коду (US3)

- [x] T006 [US3] shared: закриті списки кодів транскрибації, стітчера, landing, оцінки; агентські черги виставляють `errorCode`; веб передає в `error_occurred`/`estimate_failed`; тести агента й веба.
- [x] T007 [US3] `scripts/analytics/code-map.ts` + тест повноти й існування файлів.
- [x] T008 Продюсер `team_preview_completed`; реєстр `emitted`; тест.

## Phase 4: Розслідування (US1, US4)

- [x] T009 [US1] CLI `journal`; CLI `investigate` за FR-005; тести на PGlite з контрольним набором SC-001.
- [x] T010 [US4] AGENTS.md runbook + таблиця питань; `docs/ANALYTICS_CLI.md`.

## Phase 5: Verify і коміт

- [x] T011 `npm run verify` зелений; `findings.md`; коміт.
