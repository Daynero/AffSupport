# Data Model: автоаналітика платформи

## Envelope v3 (`public.analytics_events`, аддитивно)

| Колонка | Тип | Джерело | Примітка |
| --- | --- | --- | --- |
| `agent_instance_id` | uuid null | health `instanceId` | per-boot, не PII |
| `agent_platform` | text null (`macos|windows`) | health `capabilities`/нове поле `platform` | авторитетна платформа; `platform` (браузер) лишається |
| `attempt_id` | text null (opaque id regex) | властивість → колонка | як `flow_id`/`run_id` |
| `event_version` | 2 для подій із новим envelope | клієнт | старі клієнти шлють 1 |

## Delivery report (подія `analytics_delivery_report`)

```text
properties:
  rejected_count     0..100000
  evicted_count      0..100000
  expired_count      0..100000
  rejected_events    text  — до 10 імен подій через кому (enum імен)
  evicted_events     text  — те саме
  report_window_ms   0..86 400 000
```

Емітиться: на успішній доставці, якщо лічильники > 0; і раз на сесію. Лічильники обнуляються після прийняття звіту (сам звіт ніколи не витісняється).

## Черга клієнта

- Розмір 40 → 60; при переповненні витісняється найстаріша подія з класу `progress` (`estimate_*`, `operation_stage_*`, `*_impression`), потім `informational`, лише потім `terminal` (`*_completed|*_failed|operation_cancelled|error_occurred|analytics_delivery_report`).
- Expiry 7 днів за `occurred_at` (031 FR-030/FR-013).

## Readiness (`tool_ready`)

```text
tool_identifier, outcome: success|failure|skipped, duration_ms, error_code?, error_stage: initial_read|subscribe
```

## Error (`error_occurred`, для кожного інструмента)

`tool_identifier`, `flow_id|run_id`, `error_stage` (закритий enum на інструмент), `error_code` (стабільний, з агента або з UI-перевірки), `error_fingerprint = <tool>:<stage>:<code>`, `retryable`.

## Журнал агента (`apps/agent/src/server/diagnostics-log.ts`)

```text
record: { seq: number, at: number, category: DiagnosticCategory, code: string, props?: Record<string, number|boolean|string(enum)> }
DiagnosticCategory: boot|shutdown|stream|auth|entitlement|spawn|picker|drop|update|power|team
limits: 2 000 записів або 1 МБ у пам'яті; файл diagnostics.jsonl атомарно, ротація 2×
forbidden: шляхи, назви файлів, URL, токени, команди, stderr
```

`GET /api/diagnostics?since=<seq>&limit=<n≤500>` → `{ ...існуючий envelope, log: record[], nextSeq }`.

## Coverage registry (`scripts/analytics/coverage-registry.ts`)

```ts
interface Capability {
  id: string;                       // 'compressor.run'
  tool: AnalyticsTool | 'team' | 'link' | 'update' | 'analytics';
  stages: string[];
  start: { event: AnalyticsEventName; correlate: 'run_id'|'flow_id'|'attempt_id' }[];
  terminal: { event: AnalyticsEventName; correlate: ... }[];
  readiness?: AnalyticsEventName;
  error?: AnalyticsEventName;
  platforms: ('macos'|'windows')[];
  unobservable: string[];
  sinceWebBuild?: string;           // перша версія клієнта, що емітить
}
```

## Артефакт `audit` (`analysis/<date>.json`)

```json
{
  "ok": true, "command": "audit", "as_of": "...", "period": {...},
  "data": {
    "capabilities": [{ "id": "...", "status": "covered|partial|uncovered|declared_but_never_emitted", "missing": ["..."], "orphan_starts": 0, "samples": 0 }],
    "unknown_codes": [{ "tool": "...", "count": 0 }],
    "delivery": { "rejected": 0, "evicted": 0, "expired": 0, "by_event": [...] },
    "uncovered_builds": ["..."],
    "delivery_lag_ms": { "p50": 0, "p95": 0 },
    "findings": [{ "id": "sha256-of-(capability,status,missing)", "severity": "...", "evidence": [...] }]
  }
}
```

## Retention

- `analytics_daily_tool_outcomes(day, tool, local_app_version, platform, starts, completions, failures, cancellations, users)` і `analytics_daily_events(day, event_name, count, users)` — матеріалізуються щодня.
- Purge `analytics_events` старіше 90 днів після матеріалізації.
- `delete-account`: `installation_id`, `session_id` → `null` для `user_id` акаунта (вже nullить `user_id`).
