# Contract: read-only діагностика sync-jobs (реліз A)

## View `public.analytics_catalog_sync_jobs` (міграція M2)

Власник `postgres`, `security_invoker = false`; `revoke all from public, anon, authenticated, service_role`; `grant select to wishly_analytics_ro`. Джерела: `private.catalog_sync_jobs j`, `private.catalog_sync_authority a`, `public.team_drive_connections c`, `private.catalog_sync_requests r` (з релізу B; до того — null-колонки), canonical `k` (incremental job того ж connection у `pending/leased/retry`, інакше останній terminal).

| Колонка | Джерело | Примітка |
| ------- | ------- | -------- |
| `job_id`, `team_id`, `connection_id` | j, c | |
| `connection_state` | c.state | `live`, `detached`, … |
| `job_kind`, `phase`, `state` | j | сирі значення БД, не проєкція |
| `scope_hash` | `left(encode(sha256(j.requested_folder_id::bytea),'hex'),12)` | null для root; зіставлення з логами, не з Drive |
| `requested_by` | j / r | uuid користувача |
| `request_id`, `request_key_hash`, `request_outcome`, `detached_at` | r | null до релізу B |
| `created_at`, `updated_at`, `completed_at`, `scan_completed_at`, `last_progress_at` | j | |
| `lease_expires_at`, `lease_epoch`, `run_count`, `attempts`, `lease_lost_count`, `no_progress_runs`, `next_attempt_at` | j | `no_progress_runs` null до релізу D |
| `replay_after`, `confirmed_sequence`, `confirmed_at`, `recovery_count`, `last_recovery_at` | j, a | |
| `canonical_job_id`, `canonical_state`, `canonical_error_code`, `canonical_next_attempt_at` | k | |
| `last_error_code`, `error_detail` | j | |
| `cancel_requested_at` | j | null до релізу B |
| `files_listed`, `files_added`, `files_updated`, `files_removed`, `items_unavailable`, `folders_done` | j | 0 до релізу B |

Відсутні за побудовою: `cursor`, `folder_queue`, `confirmed_cursor`, `page_token`, `lease_owner`, будь-які назви та Drive-ідентифікатори у відкритому вигляді. pgTAP-тест перевіряє список колонок і відсутність заборонених.

## Команда CLI

```bash
npm run analytics -- sync <team-id | owner-email> [--limit N] [--json]
```

- `owner-email` резолвиться через `analytics_users` (наявний read-only шлях); якщо у користувача кілька просторів — виводяться всі, відсортовані за `updated_at desc`.
- SQL — лише через `runQuery` з `assertReadOnlySql`; значення — bound-параметри; `--limit` 1..500, default 50.
- Envelope — як у решти команд: `{ ok: true, command: 'sync', generated_at, period, data }` (`period` — резолвлений період CLI, для цієї команди неінформативний) або `{ ok: false, command: 'sync', error }`.
- `data`: `{ team_id, connections: [{ connection_id, connection_state, canonical: {...}, jobs: [...] }] }`, рядки — колонки view як є, без `owner_email_normalized` (він існує у view лише для фільтра).
- Людський формат: таблиця `job | kind | phase | state | age | progress | attempts/lost | waits_for | error`; `waits_for` = `seq N (canonical: state/err)` для waiters.

Тест `tests/analytics-sync-command.test.ts`: PGlite із view і фікстурами (waiter із failed canonical, waiter із retry canonical, leased прострочений), перевірка форматування та `--json`; snapshot-перевірка, що жоден рядок не містить `cursor`/`token`.

## Лог worker-а

`catalog_sync_job_result` (успіх/помилка/lease_lost) додає `teamId`, `connectionId`, `workerId`, `leaseEpoch`. Нова подія `catalog_sync_rpc_error { rpc, code, message }` без параметрів виклику. Жодних токенів, курсорів, назв — перевірка grep-ом у `tests/catalog-sync-worker-log.test.ts` на фейковому RPC-клієнті.
