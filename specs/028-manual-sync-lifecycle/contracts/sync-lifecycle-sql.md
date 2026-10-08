# Contract: SQL життєвого циклу синхронізації (міграції M1–M4)

Усі функції: `security definer`, `set search_path = ''`, fully-qualified імена, `revoke all` + narrow `grant`. Кожна міграція має розділ у `supabase/migrations/ROLLBACK.md`, pgTAP-тест і PGlite-тест. Рішення — у [research.md](../research.md).

## M1 — `sync_orphan_recovery` (реліз A)

### DDL (additive)

```sql
alter table private.catalog_sync_jobs
  add column error_detail text,
  add column scan_completed_at timestamptz,
  add column lease_lost_count bigint not null default 0;
alter table private.catalog_sync_authority
  add column recovery_count bigint not null default 0,
  add column last_recovery_at timestamptz;
```

### Змінені функції (CREATE OR REPLACE, ті самі сигнатури)

| Функція | Зміна | Контракт |
| ------- | ----- | -------- |
| `public.service_retry_catalog_sync_job(uuid, text, boolean, integer, bigint)` | при terminal incremental: non-retryable → waiters `failed/CANONICAL_FAILED` з `error_detail = p_error_code`; retryable exhausted → вставити canonical (`next_attempt_at = now + 5 min`), `recovery_count + 1`; `recovery_count` за 24 год ≥ 6 → як non-retryable | повертає як раніше; нові коди в `last_error_code` |
| `public.service_complete_catalog_sync_job(uuid, text, jsonb, text, bigint)` | finite-гілка: `scan_completed_at = now`; nudge canonical `state in ('pending','retry')` | без змін сигнатури |
| `public.request_team_folder_resync(uuid, text)` / `public.request_team_catalog_resync(uuid)` | після join/insert: nudge canonical `state in ('pending','retry')` | повертають `sync_job_id` як раніше |
| `public.get_team_folder_sync_status(uuid, uuid)` | включити root scans (`or job_kind in ('initial','reconcile')`, `scopeFolderId = '__root__'`); решта полів без змін до M3 | потрібно stall-детектору релізу A |
| `public.service_claim_catalog_sync_work(...)` | повертає також `team_id` | для логу worker-а |
| `private.claim_catalog_sync_jobs(...)` | перехоплення простроченого lease: `attempts = least(attempts+1,1000)`, `lease_lost_count + 1`; якщо `attempts + 1 >= 10` → `failed/LEASE_LOST_EXHAUSTED` замість claim | повертає claimed rows як раніше |
| `private.invoke_catalog_sync_worker()` | gate: `and j.replay_after is null` | |

### Нові функції

```sql
-- Викликається з cron 'wishly-catalog-sync-retention' перед cleanup; без нового cron-рядка.
create function private.sweep_catalog_sync_orphans(p_limit integer default 200)
returns jsonb;  -- {"canonical_created":n,"replay_timeout":n,"detached":n,"lease_exhausted":n}

-- Read-only lookup для R7 (реліз A); у релізі B замінюється на пошук за request_key.
create function public.find_team_folder_sync_request(p_team uuid, p_folder text)
returns table (sync_job_id uuid, state text, created_at timestamptz);
-- owner/admin/member; останній job цього scope за 30 хв у pending/leased/retry/succeeded/failed.
```

Правила sweeper: (1) waiter без canonical у `pending/leased/retry` старший за 2 хв → insert canonical; (2) `scan_completed_at < now - 60 min` → `failed/REPLAY_TIMEOUT`; (3) connection `detached` → `canceled/CONNECTION_DETACHED`; (4) `leased`, `lease_expires_at < now - 15 min`, `attempts >= 10` → `failed/LEASE_LOST_EXHAUSTED`. Усе під `for update skip locked`, не більше `p_limit` рядків на виклик.

### Одноразовий data-fix у M1

Той самий код, що sweeper (1)–(3), без обмеження часу 2 хв; плюс `leased` з простроченим lease → `pending`, `attempts + 1`. Нічого не видаляється, `confirmed_*` не змінюється.

### Коди помилок (closed set, додаються до наявних)

| Код | Де | Дія для користувача |
| --- | -- | ------------------- |
| `CANONICAL_FAILED` | waiter | дивитись `error_detail`: `NEEDS_REAUTH` → перепідключити Drive; `PERMISSION_DENIED` → надати доступ; інше → повторити |
| `REPLAY_TIMEOUT` | waiter | повторити; якщо повторюється — діагностика |
| `LEASE_LOST_EXHAUSTED` | будь-який | повторити; сигнал для власника продукту |
| `CONNECTION_DETACHED` | будь-який | підключити Drive знову |
| `PAGE_TOKEN_REJECTED` | detail `INVALID_INPUT` | внутрішній; generation перезапускається |

## M2 — `sync_diagnostics_view` (реліз A)

Див. [diagnostics-cli.md](diagnostics-cli.md). `create view public.analytics_catalog_sync_jobs ...; revoke all ...; grant select on public.analytics_catalog_sync_jobs to wishly_analytics_ro;`

## M3 — `sync_requests_and_cancel` (реліз B)

### DDL

```sql
create table private.catalog_sync_requests (...);              -- див. data-model §3
alter table private.catalog_sync_jobs
  add column cancel_requested_at timestamptz,
  add column cancel_requested_by uuid,
  add column files_listed bigint not null default 0, ... items_unavailable, folders_done;
```

### RPC

| Функція | Хто | Контракт |
| ------- | --- | -------- |
| `public.request_team_folder_resync(p_team uuid, p_folder text, p_request_key text)` (новий overload) | owner/admin | повертає `(sync_job_id uuid, request_id uuid, outcome text)`; той самий `p_request_key` → той самий результат; старий 2-arg overload лишається і генерує ключ сам |
| `public.request_team_catalog_resync(p_team uuid, p_request_key text)` | owner/admin | аналогічно для root |
| `public.cancel_team_folder_sync(p_team uuid, p_request_id uuid)` | owner/admin або `requested_by` | `detached` якщо роботу поділяють або вона incremental; інакше `cancel_requested_*`; `pending/retry` → одразу `canceled/CANCELED_BY_USER`; повертає `(job_state text, request_outcome text)` |
| `public.get_team_folder_sync_status(p_team uuid, p_job uuid)` (розширена) | member+ | мапа станів R8 (root уже з M1); нові поля з data-model §5; 3-value `get_team_folder_resync_status` не змінюється |
| `private.lock_catalog_sync_lease(...)` | внутрішня | додається умова `cancel_requested_at is null`; відмова → worker отримує `lease_lost` |
| `commit_catalog_scan_page`, `resolve_catalog_candidate`, `finish_catalog_folder`, `upsert_catalog_page`, `tombstone_catalog_files` | внутрішні | інкрементують лічильники на job; `on conflict ... returning (xmax = 0) as inserted` для added/updated |
| `private.claim_catalog_sync_jobs` | внутрішня | job із `cancel_requested_at` у `pending/retry` → `canceled`, не claim |
| `private.join_catalog_subtree` | внутрішня | не приєднує до jobs із `replay_after is not null`; натомість один follow-up (FR-007) |

## M4 — `sync_replay_fencing` (реліз D)

Нові overloads із `p_lease_epoch bigint` для `upsert_catalog_page`, `tombstone_catalog_files`, `invalidate_landing_renders`, `mark_folder_indexed`, `mark_root_state`, `touch_catalog_reconciled`, `enqueue_catalog_reconciliation`: перший рядок — `perform private.lock_catalog_sync_lease(p_job, p_worker, p_epoch)`, при відмові `raise exception 'LEASE_LOST'`. Старі сигнатури лишаються один реліз і пишуть `raise warning 'UNFENCED_RPC %'`. `claim`: `progress_at_last_claim`, `no_progress_runs` (R3, повна версія); `no_progress_runs >= 10` → `failed/NO_PROGRESS`.

## Worker (edge function), реліз A

- `_shared/drive.ts#request`: мапа R5 (rate-limit 403 → `RATE_LIMITED`; page token 400 → `INVALID_INPUT`/`PAGE_TOKEN_REJECTED`); тіло помилки читається з try/catch.
- `proveLiveAncestry` / `isWithinRoot`: ярлик → `unavailable` з причиною `shortcut`, не exception.
- `index.ts#rpcValue`: `console.error({ event: 'catalog_sync_rpc_error', rpc: name, code: error.code, message: error.message })` без параметрів; далі як зараз (`DRIVE_UNAVAILABLE` retryable).
- `catalog_sync_job_result`: + `teamId`, `connectionId`, `workerId`, `leaseEpoch`.
- Коментар про «60 s lease» в `index.ts` виправити на 180.

## Worker, реліз D

- `assertLease()` перед кожним Drive trash у `invalidateLandingRenders` і перед transcript commit.
- Бюджет перевіряється до і після кожного `getFile`/ancestry walk у reconciliation; при вичерпанні — `release` з checkpoint, не продовжувати сторінку.
- Replay: checkpoint після ancestry-walk і до transcript ingestion; ingestion — окрема bounded одиниця.
