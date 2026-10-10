# Implementation Plan: 033 — агентне розслідування користувача

**Branch**: `033-agent-user-investigation` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

## Summary

Три потоки, що сходяться в одній команді `investigate`: (A) журнал агента доходить до бази через веб і RPC із серверною перевіркою; (B) агент дає стабільні коди помилок для всіх інструментів, і кожен код має запис у мапі коду; (C) CLI збирає все про користувача в один ранжований висновок. Плюс продюсер `team_preview_completed`, runbook в AGENTS.md і два нестабільні тести, стабілізовані на старті гілки.

## Technical Context

TypeScript strict / ESM; Fastify-агент; React-веб; Postgres (Supabase), PGlite у тестах; read-only CLI (`scripts/analytics`). Обмеження: конституція III (RLS, security definer з `search_path=''`, read-only CLI), VI (без нового постійного polling — пересилання лише на тригерах), приватність FR-011.

## Constitution Check

| Принцип | Як дотримано                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------- |
| I       | закриті union-и кодів у shared; RPC валідує `unknown` вхід                                        |
| III     | таблиця з RLS, `revoke all`; RPC security definer; ro-роль лише select; CLI лишається SELECT-only |
| V       | коди помилок — стабільні машинні рядки                                                            |
| VI      | пересилання на подіях (не інтервал), через typed seam                                             |

## Design

- **Таблиця й RPC** — `supabase/migrations/20261124100000_agent_journal.sql`; категорії дублюють `DIAGNOSTIC_CATEGORIES` (тест звіряє); purge 30 днів додається у `private.purge_analytics_events` (нова версія функції).
- **Пересилання** — `apps/web/src/analytics/journal-forwarder.ts`: `forwardAgentJournal(trigger)`; викликається з `AgentContext` (успішне підключення), `analytics/errors.ts` (`error_occurred`), `analytics/link.ts` (`link_recovered`), `analytics/readiness.ts` (failure), `visibilitychange→hidden`; дебаунс 30 с; курсор `wishly.agent-journal.cursor.v1` = `{instanceId, seq}`.
- **Коди** — shared: `TRANSCRIPTION_ERROR_CODES`, `STITCH_ERROR_CODES`, `LANDING_ERROR_CODES`, `ESTIMATE_ERROR_CODES`; агентські черги виставляють `errorCode`; веб бере його в `error_occurred`.
- **Мапа коду** — `scripts/analytics/code-map.ts`: `Record<fingerprint | 'journal:<category>:<code>', { files: string[]; check: string }>`; тест: повнота і що всі файли існують.
- **CLI** — `investigate`, `journal` у `scripts/analytics/{queries,index,format,types}.ts`; findings: правила (невдалий прогін → fact; збій без коду → hypothesis + журнал; розрив без відновлення → fact; немає подій після білду X → insufficient/сліпа зона); `code_locations` з мапи.
- **`team_preview_completed`** — `apps/web/src/team/preview/MaterialPreview.tsx` (або хук відкриття прев'ю) з `attempt_id`; реєстр → `emitted`.

## Phases → [tasks.md](./tasks.md)
