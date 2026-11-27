# Diagnostic contract

## Редакція 2026-11-27 (переважає таблицю нижче)

Серверних подій в `analytics_events` немає. Серверні докази — приватний журнал
`private.space_storage_journal` і проєкція `public.analytics_space_storage`, як у 050
(`private.catalog_video_r2_journal`, `scripts/analytics/catalog-video-r2.ts`). Клієнтські
спостереження («показано», «відтворення почалось») ідуть наявним
`public.ingest_analytics_events` (`apps/web/src/analytics/service.ts`).

| Шлях               | Стадії                                                                                                  | Доказ завершення й негативні випадки                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| створення простору | `requested` → `pilot_checked` → `created` → `visible`                                                   | рядок `teams` + клієнтське `visible`; немає дозволу пілоту, повтор ключа, старий клієнт                                 |
| завантаження       | `admitted` → `reserved` → `parts_signed` → `completed` → `committed` → `derivatives_queued` → `visible` | `space_objects` + рядок обліку + сигнал; дубль за хешем, квота, обрив посередині, протермінована сесія, відкликана роль |
| похідні            | `queued` → `running` → `ready`/`unsupported`/`failed`                                                   | ключ похідної + `thumbnail_state`; повтор обмежений, `corrupt` при розбіжності хешу                                     |
| читання            | `grant_issued` → `authorized` → `served`                                                                | клієнтське `preview_loaded`/`playback_started`; обірване скачування — `unknown`, не успіх                               |
| видалення          | `trashed` → `purge_queued` → `r2_deleted` → `usage_released`                                            | `space_object_purges.deleted` + різниця обліку; спільний об'єкт лишився, повтор безпечний                               |
| звірка             | `listed` → `compared` → `orphans_deleted`                                                               | `space_storage_reconciliations`: розбіжність обліку з R2 — помилка, не попередження                                     |
| стрічка каталогу   | `rows_built` → `feed_written` → `cache_purged` → `external_fetch` (необов'язково)                       | `feed_revision` + `feed_written_at`; збій запису не ламає попередню стрічку                                             |
| вхідні (M2)        | `detected` → `hashed` → `admitted` → `uploaded` → `committed`                                           | один матеріал на файл; дубль, сон, обрив, знята роль                                                                    |
| архів (M3)         | `policy_checked` → `write_denied`                                                                       | код `SPACE_ARCHIVED` на всіх шляхах; 0 запусків синхронізації й оновлювачів архівних просторів                          |

**CLI.** M1 додає команду `space-storage`: облік простору, звірка, сироти, черги похідних і
видалення, затримки фіксації → сигнал. M3 розширює `investigate`, `inspect`, `audit` і
додає `storage-capacity`. Реєстрація — `COVERAGE_REGISTRY`, `CODE_MAP`, `case` у `cli.ts`.

Рядок `migration` у таблиці 2026-11-14 нижче не діє (FR-055). Рядок `billing/retention` діє
лише в частині 034-видачі з місткістю (R11).

## (2026-11-14) Original contract

Extend existing typed analytics and authoritative privacy-limited DB projections. Detail90d and existing aggregate retention policy; high-frequency progress aggregated, terminals and critical state never sampled. Original application audit/financial retention is separate from analytics detail. No user content, raw path/name/Drive IDs, URL query tokens, keys or provider payloads in diagnostics. Tenant/resource UUIDs only where current private CLI contract allows, aggregate summaries for repository evidence.

| Journey           | Expected stages                                                                                                          | Terminal proof and negative cases                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| org/create/choice | shown → choice_saved → admitted → quota_reserved → provisioned → visible                                                 | durable same-id creation receipt + client observation; canceled before admit, repeated key, wrong owner, missing visible receipt                                                           |
| quota/upload      | intended → admitted → reserved → parts → verifying → committed → replica_verified → metadata_protected → visible         | canonical version/hash/bytes, ledger delta, joint watermark; quota race, unknown provider completion, authority revoked, interrupted multipart                                             |
| preview/download  | queued → claimed → rendered/read_authorized → delivered                                                                  | generated derivative version, bounded decode code, client preview loaded/download started or finished where observable; aborted browser download has unknown completion, not false success |
| migration         | decision → inventoried → copied → caught_up → fenced → verified → protected → cutover → validated → visible              | manifest totals, exclusions, atomic cutover and independent commit journal; stale token, root missing, source_changed, reference gap, quota change, late agent write, replica lag          |
| legacy/catalog    | policy_checked → snapshot_checked → refresh_claimed → sources_verified → feed_published → external_probe → visible       | same eligible catalog, source snapshot and publication epoch; write_denied distinct from execution failure; Google bridge visibly pending retirement                                       |
| recovery          | detected → declared → fenced → checkpoint_selected → restored → auth_validated → read_ready → reconciled → primary_ready | external independent probe + restore manifest + current deny boundary; missing checkpoint/hash/auth proof blocks readiness                                                                 |
| billing/retention | quoted → accepted → granted → grace → readonly → notified → purge_due → logical_deleted → physical_expired               | grant receipts, exact quota ledger, notice attempt/result, retention lock/ref evidence; no payment-success claim from manual quote                                                         |

All signals include schema/version, environment, web/agent build/platform where applicable, operation_id, attempt_id, parent_id, flow_id, safe stage enum, outcome/code/retryability, happened/received time, sequence and counts/bytes bounded as decimal strings. Source coverage and delivery watermarks separate from business times. New codes registered in `packages/shared/src/types.ts`, team transport and `scripts/analytics/code-map.ts` with originating/surfacing code paths.

CLI extensions (same `{ok,command,generated_at,period,data}`):

- `team-workspace`: migration/maintenance/preview/protection aggregate cohorts and denied-write counts, current availability separate from event counts.
- `investigate <subject>` and `inspect <operation>`: exact stage chain, expected vs found, authoritative receipts, fact/hypothesis/insufficient, last_proven_stage, reason and repair path; join object/cutover/restore generation safely.
- `audit`: capability registry for each producer/consumer/CLI, missing terminals, unknown codes, lag, orphaned reservations, false protected state, retired client cohort.
- proposed `storage-capacity [--period ...] [--as-of ...] --json`: logical/physical reserved/committed/retained/staging by provider, object counts/unknown byte counts, adoption/grants seats/spaces, request/compute/churn aggregates, cost_estimate vs actual invoice, completeness/watermark/units. Historical mutable counters unavailable unless sampled: explicitly unsupported, never reconstruct false history.

Each source returns supported/unknown/truncated/fresh_through. Missing projection yields unsupported_by_producer or explicit read-error, not zero. Repeated analysis of same immutable snapshot dedup findings; CLI remains bounded SELECT-only, no `--fix` or migration mutation option.

Acceptance: each critical journey success + failure + interrupted/cancel + missing/delayed terminal; namespace isolation/secret canary; duplicate/out-of-order delivery; authoritative success with no UI evidence; analytic outage while product succeeds; restore while collector unavailable. Capture invocation, safe JSON fixture, expected finding and code-map location. Operator incident log and independent monitors cover total telemetry outage. Reporter unable to observe recovery emits insufficient rather than diagnosing its own unreachability as service death.
