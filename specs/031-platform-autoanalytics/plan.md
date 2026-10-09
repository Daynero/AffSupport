# Implementation Plan: Агентна автоаналітика та діагностика платформи

**Branch**: `031-platform-autoanalytics` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md) (зведена версія) | **Research**: [research.md](./research.md)

## Summary

Збір подій сьогодні дірявий у чотирьох місцях, і жодне не видно: серверний guard тихо відкидає ключі, які клієнт шле навмисно; клієнт тихо губить події після трьох спроб і витісняє найстаріші без лічильника; половина оголошених подій ніде не емітиться, а CLI їх рахує; агент не має жодного запису про власні рішення. План іде за пріоритетами спеки: (1) контракт клієнт↔guard як тест у `verify` і ремонт відомих розходжень; (2) звіт доставки з лічильниками втрат; (3) `run_id`, terminal-події, `tool_ready`, `error_occurred` для кожного інструмента; (4) `agent_instance_id`/`agent_platform` в envelope; (5) локальний журнал агента і `/api/diagnostics?since=`; (6) реєстр можливостей, `audit`, `inspect`, `--as-of`, `delivery_lag`, `unsupported_by_producer`; (7) retention. Жодного дашборда, LLM чи телеметрії з агента в хмару.

## Technical Context

**Language/Version**: TypeScript strict, ESM NodeNext; Node 22; React 19; Fastify 5; Postgres (Supabase), PGlite у тестах

**Primary Dependencies**: `apps/web/src/analytics/*` (typed seam), `scripts/analytics/*` (read-only CLI, `pg`), `supabase/migrations`, `@video-compressor/shared` (team analytics sanitizer)

**Storage**: `public.analytics_events` (+ колонки `agent_instance_id`, `agent_platform`, `attempt_id`), нова `public.analytics_delivery_reports` або подія `analytics_delivery_report`, `analytics_daily_*` агрегати, pg_cron retention

**Testing**: vitest single-worker; PGlite з реальним тілом guard-функції; pgTAP для міграцій; `tests/support/minimal-agent.ts` для агента

**Target Platform**: macOS/Windows агент, веб у Chrome/Safari (локальна копія)

**Project Type**: монорепо web + agent + shared + scripts + supabase

**Performance Goals**: збір не збільшує p95 інтерактивної дії більш як на 5% (SC-009); `audit` 7 днів/35 користувачів ≤ 5 хв (SC-003); журнал агента ≤ 1 МБ

**Constraints**: конституція III (read-only CLI у трьох шарах; жодних секретів/шляхів у подіях; нові таблиці з RLS), V (стабільні машинні коди), VI (typed `analytics.track`), II (контракти не бампаються заради релізу)

**Scale/Scope**: ~40 користувачів, ~13 000 подій/30 днів сьогодні; реєстр ~25 можливостей; ~12 інструментальних файлів у вебі; 3–4 міграції; 3 нові команди CLI

## Constitution Check

| Принцип | Як дотримано |
| --- | --- |
| I | enum-и подій — string-literal unions; guard-контракт генерується з них; `unknown` з агента narrowed |
| II | `AGENT_API_VERSION` незмінний; `/api/diagnostics?since=` і `tool_ready` — аддитивні |
| III | CLI лишається SELECT-only; нові таблиці — RLS + column grants; журнал агента без шляхів/секретів; bundle показується користувачу до копіювання |
| IV | журнал агента пише з існуючих spawn-seam-ів (`power/spawn.ts`), без нових child-process шляхів |
| V | `error_code` з агента — стабільні коди; `/api/diagnostics` зберігає envelope |
| VI | один typed seam `analytics.track`; без polling; `tool_ready` емітиться з наявних initial-read ефектів |
| Verify | контрактний тест guard-а і реєстру — у `npm run verify` |

Порушень немає.

## Project Structure

### Documentation (this feature)

```text
specs/031-platform-autoanalytics/
├── spec.md              # зведена
├── research.md          # незалежне читання + факти
├── plan.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── analytics-events.md     # нові події/ключі/envelope
│   ├── agent-diagnostics.md    # журнал агента і /api/diagnostics v2
│   └── analytics-cli.md        # audit / inspect / --as-of / delivery_lag
├── analysis/            # артефакти audit (git-ignored крім README)
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/src/analytics/
├── events.ts            # нові імена/ключі; експорт ALLOWED_PROPERTY_KEYS/ENUMS для контракту
├── service.ts           # лічильники втрат, delivery report, пріоритет terminal при витісненні, agent_instance_id/agent_platform в envelope
├── tools.ts             # run_id у generic lifecycle; tool_ready
├── compression.ts       # коди з агента замість regex
├── readiness.ts         # trackToolReady(tool, outcome, durationMs, code?)
└── guard-contract.ts    # серіалізація allowlist для SQL-тесту
apps/web/src/{transcription,stitcher,landing,landing-preview,team/processing,team/restitch}/… # terminal + error_occurred + tool_ready
apps/web/src/team/create/CreateSpaceWizard.tsx   # один onboarding start на flow
apps/web/src/support/…                           # bundle з /api/diagnostics (показ → копіювання)

apps/agent/src/server/diagnostics-log.ts         # ring buffer (seq, at, category, code, props)
apps/agent/src/server/app.ts                     # /api/diagnostics?since=; GET лишається entitlement-exempt
apps/agent/src/{power/spawn.ts,server/sse.ts,entitlement/entitlement.ts,files/picker.ts,index.ts}  # записи у журнал

packages/shared/src/team/analytics.ts            # duration_ms bound узгоджений; attempt_id

scripts/analytics/
├── coverage-registry.ts  # реєстр можливостей
├── queries.ts            # getAudit, getInspect, delivery lag, --as-of
├── index.ts, format.ts, types.ts
supabase/migrations/
├── <ts>_analytics_guard_contract.sql   # відсутні ключі + enums (team/power/library/landing)
├── <ts>_analytics_envelope_v3.sql      # agent_instance_id, agent_platform, attempt_id; delivery report
├── <ts>_analytics_retention.sql        # daily aggregates + pg_cron purge 90d; delete-account anonymisation
supabase/tests/database/*.sql
docs/ANALYTICS_CLI.md, AGENTS.md

tests/
├── analytics-guard-contract.test.ts     # клієнтський allowlist ⊆ guard (PGlite з реальним тілом)
├── analytics-delivery-report.test.ts
├── analytics-run-ids.test.tsx           # кожен інструмент: start+terminal з одним run_id; tool_ready
├── analytics-error-codes.test.ts
├── agent-diagnostics-log.test.ts
├── analytics-coverage-registry.test.ts  # кожна подія реєстру існує в events.ts; кожна CLI-подія в реєстрі
├── analytics-audit-command.test.ts
├── analytics-inspect-command.test.ts
├── analytics-as-of.test.ts
└── analytics-retention.test.sql (pgTAP)
```

**Structure Decision**: існуючі модулі; нові файли лише для реєстру, журналу агента, readiness і контракту guard-а.

## Phase 0 — Research (done)

[research.md](./research.md): інвентар продюсерів/сховища/споживача, 12 відкинутих ключів, 42 неемітовані події, orphan starts, бага CreateSpaceWizard, відсутній retention, тести без guard-а; виміряний стан за 30 днів.

## Phase 1 — Design

- [data-model.md](./data-model.md): envelope v3, delivery report, журнал агента, реєстр, артефакт audit.
- [contracts/](./contracts/): події, діагностика агента, CLI.
- [quickstart.md](./quickstart.md): автоматичні перевірки, бета-прохід з ін'єкціями, перевірка privacy.

### Ключові рішення

1. **Контракт у коді, не в документації.** `events.ts` експортує allowlist+enums; тест завантажує реальну міграцію guard-а у PGlite і проганяє кожен ключ/enum/bool/range. Розходження = червоний `verify`.
2. **Delivery report як звичайна подія** `analytics_delivery_report{rejected, evicted, expired, by_reason}` з bounded лічильниками — без нової таблиці, без нового транспорту.
3. **Пріоритет при витісненні**: черга тримає terminal/error події до останнього; progress витісняється першим.
4. **`run_id` всюди через наявний generic lifecycle** (`tools.ts`): snapshot-diff уже знає job id; додати його в envelope.
5. **Журнал агента — ring buffer у пам'яті + атомарний файл** (`diagnostics.jsonl`, ≤ 1 МБ, ротація), категорії закриті, значення — коди/тривалості/лічильники; `/api/diagnostics?since=seq` віддає хвіст; bundle = хвіст + envelope-метадані.
6. **`audit` детермінований**: `--as-of` фіксує `created_at <= as_of`; артефакт сортований; без часових міток «зараз» усередині даних (лише в envelope).
7. **Retention через pg_cron** (доступний у Supabase); daily aggregates матеріалізуються перед purge; delete-account анонімізує installation/session.

## Phase 2 — Tasks

[tasks.md](./tasks.md). Порядок: Foundation (контракт guard-а, ремонт ключів, delivery report) → Instruments (run_id/terminal/tool_ready/error_occurred) → Envelope → Agent log → CLI (registry/audit/inspect/as-of/lag) → Retention → Verify/Quickstart.

## Risks

- pg_cron може бути недоступний на поточному плані Supabase — fallback: scheduled Edge Function; план перевіряє `verify-production-config`.
- Більше подій на операцію (tool_ready, error_occurred) — у межах 40-елементної черги при пріоритеті terminal; квота перевіряється тестом SC-009.
- Зміна envelope (нові колонки) потребує `npm run types:supabase`; старі клієнти шлють без них — колонки nullable.
