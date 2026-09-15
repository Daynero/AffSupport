# 2026-09-15 — the catalog sync worker stopped, nothing indexes

**Status: mitigated in production; worker healthy and both spaces are actively indexing. The
durable migration is not yet applied to production — see "Still open" below.**

## Execution update — 2026-09-15 16:15 Kyiv

- Production cron is active on its 10-second schedule and every recent run completes the SQL call.
- Both Vault values exist and pass the length checks (URL 66 characters, secret 64).
- Every worker HTTP response is `503 {"code":"DRIVE_UNAVAILABLE","retryable":true}`; queued
  jobs remain unclaimed.
- The Supabase organization is over its Free-plan egress quota: 7.48 GB used of 5 GB. The Billing
  page warns that projects can become unresponsive under this restriction. Restoring service
  therefore requires upgrading Totem to Pro (from $25/month); no payment method is configured.
- DreamTeam now has one live connection and its older rows are detached, so the contradictory live
  rows described below have already been cleaned up.
- `20260916100000_catalog_sync_outage_guards.sql` closes the remaining code gaps: invalid worker
  Vault configuration now fails the cron run explicitly, and both connection-status readers use the
  same ordering. The existing storage-health staleness check and manager retry action cover a stuck
  first scan.

### Resolution update — 2026-09-15 16:34 Kyiv

The Pro upgrade removed the usage restriction, but the worker still returned 503. A rollback-only
call to `service_claim_catalog_sync_jobs` exposed the real database error: historical job
`0d970927-226f-433f-8fca-273e7b82fb4a` had reached the schema ceiling of 1000 attempts. The claim
function selected it first and tried to write attempt 1001, so the check constraint rolled back the
entire claim before any fresh job could start.

Production was hotfixed by replacing only `private.claim_catalog_sync_jobs`: runnable exhausted jobs
are now retired as `failed / RETRY_EXHAUSTED`, and candidates are limited to `attempts < 1000`. The
next cron tick returned 200 (`claimed=1`, `completed=1`, `failed=0`) and upserts resumed. Five-minute
proof while the scans were still walking their live Drive trees:

- Test team: 640 files / 184 folders, 128 upserts in five minutes.
- DreamTeam: 478 files / 423 folders, 256 upserts in five minutes.
- The counts exceeded the old screenshot because Drive contents changed while the worker was down.

The durable migration and regression test are in
`20260916100000_catalog_sync_outage_guards.sql` / `team-sync-claim-sql.test.ts`.

### Still open — production and this repository disagree

Checked 2026-09-15 16:44 Kyiv with `node scripts/verify-production-config.mjs --json`: migration
`20260916100000` is **not applied to production**. Production is running the hand-replaced
`private.claim_catalog_sync_jobs` and nothing else from that file, so two of its three guards are
repo-only:

- `private.invoke_catalog_sync_worker()` in production still returns `null` silently when the Vault
  configuration is invalid, and still POSTs on every 10-second tick even when no job is runnable.
  The migration makes the first raise into `cron.job_run_details` and skips the second — which also
  removes most of the ~259k monthly edge-function invocations the idle cron was spending.
- `public.get_drive_connection_status` in production still orders by `created_at` while
  `get_team_storage_health` orders by `connected_at`, so the two can still name different
  connections for a space that has more than one live row.

Applying the migration is safe — all three are `create or replace`, and its claim function is the
logic already running in production. It needs a backend release (`npm run release:backend-plan`
then `release:backend-apply`); until then, do not assume production matches this repository.

Independent verification of the mitigation, same timestamp: 30–100 `upserted` events per minute,
newest five seconds old; DreamTeam at 1006 files / 190 folders indexed, up from zero.
The regression test passes locally: `tests/team-sync-claim-sql.test.ts`, 7/7.

Written for an agent with Supabase Dashboard / Management API access. Everything below the
"Already established" line is measured fact — do not spend time re-deriving it.

---

## Symptom the owner reported

Files do not index. The owner connected a new space (DreamTeam, root `Арбітраж`,
`san4omy97@gmail.com`) and it never leaves "scanning". Neither his space nor the owner's own
"Test team" indexes anything.

---

## Already established (do not re-measure)

1. **The worker has produced no output since 2026-09-15 09:37:52 UTC.** `team_catalog_events`
   rows of kind `upserted` per hour:

   | UTC hour (09-14/09-15) | 22  | 23  | 00  | 01  | 02  | 03  | 04  | 05  | 06  | 07  | 08  | 09  |
   | ---------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | upserts                | 84  | 80  | 72  | 84  | 100 | 80  | 92  | 100 | 44  | 0   | 0   | 9   |

   It degraded from ~06:00 UTC and died at 09:37:52. Every event after that timestamp is
   `sync_state` (written by the request side, not the worker).

2. **Jobs are created and never claimed.** `request_team_catalog_resync` on "Test team"
   (a previously healthy, fully synced space) returned job
   `6e49573f-3716-4bcd-af61-2b967e4e0e7b` and moved the connection to `scanning`. **Sixteen
   minutes later, with a 10-second cron, zero events.** The problem is not the new space and
   not the owner's Drive — no worker is picking anything up.

3. **The edge function is deployed and boots.** `POST https://<ref>.supabase.co/functions/v1/catalog-sync`
   with no secret header answers `401 {"code":"AUTH_REQUIRED"}` — its own check, from
   `requireNamedWorkerSecret`. `drive-ops` likewise. So the break is between pg_cron and the
   function, or inside the function before it claims.

4. **Production config is otherwise clean.** `node scripts/verify-production-config.mjs --json`
   reports no missing secrets, no function drift, and only the two branch-023 migrations
   pending (`20260915140000`, `20260916090000`) plus the undeployed `catalog-updater`. All
   expected.

5. **Today's web release is not the cause.** Migration `20260915010000_product_catalogs.sql`
   (feature 022) _is_ applied in production — so it was not a web-only deploy — but it only
   widens `team_materials_companion_kind_check` to admit `product_catalog` and adds new tables
   and functions. Nothing in the sync path. The deploy is recorded at 12:24 Kyiv (09:24 UTC),
   which is _after_ the degradation started.

6. **Why nothing shows an error anywhere.** `private.invoke_catalog_sync_worker()` returns
   `null` silently when the Vault secrets `wishly_catalog_sync_url` /
   `wishly_catalog_sync_secret` are absent or the secret is shorter than 32 characters. And
   `catalog-sync` rejects a bad secret (`AUTH_REQUIRED`) or a wrong `DRIVE_OAUTH_MODE`
   (`OAUTH_APPROVAL_REQUIRED`, 503) **before** it claims any job, so no job, connection, or
   audit row records the failure. This whole break is invisible by construction.

### Second, separate bug found on the way

DreamTeam has **two non-detached `team_drive_connections` rows**, and two RPCs disagree about
which one is current:

- `get_drive_connection_status` — `order by drive.created_at desc limit 1` → the new
  connection, `initial_sync_state = 'scanning'`
- `get_team_storage_health` — `order by drive.connected_at desc nulls last limit 1` → the old
  one, `initial_sync_state = 'failed'`

That is why the owner sees "scanning" in settings and a red `sync_failed` chip on the space at
the same time. Definitions: `20260801095000_team_invitation_drive_actions.sql` and
`20260913000500_preview_chip_counts_only_live_work.sql`.

### Side effect the owner already knows about

A resync was triggered on "Test team" as the decisive experiment. It is in `scanning` with
`last_synced_at` cleared. **No data was lost** — 621 files / 180 folders, 13 root elements
(Creo 4, CV 7, Lands 1, OneMedia 1, OneMediaCreo 20, SPY 2, Tools 2, Вставки 1, Зашивка 23),
confirmed by screenshot. It re-indexes itself once the worker runs again.

---

## Step 1 — find which of the three it is (SQL Editor, read-only)

```sql
-- a. is the cron job still scheduled and active?
select jobid, schedule, active, command from cron.job where jobname = 'wishly-catalog-sync';

-- b. does it fire, and how does it end?
select status, return_message, start_time from cron.job_run_details
 order by start_time desc limit 30;

-- c. what does the function answer those POSTs? (401 / 503 / timeout / nothing)
select id, status_code, error_msg, created from net._http_response order by created desc limit 30;

-- d. are the two Vault secrets present and long enough?
select name, char_length(decrypted_secret) as len, created_at
  from vault.decrypted_secrets
 where name in ('wishly_catalog_sync_url', 'wishly_catalog_sync_secret')
 order by created_at desc;

-- e. the second bug: how many connections does DreamTeam have?
select id, state, initial_sync_state, created_at, connected_at, last_error_code, root_folder_name
  from public.team_drive_connections
 where team_id = 'e7bbca1c-a7b1-494a-8f38-d13f13961345' order by created_at desc;

-- f. is anything queued and waiting?
select id, connection_id, state, attempts, last_error_code, next_attempt_at, updated_at
  from private.catalog_sync_jobs order by updated_at desc limit 20;
```

Also read **Edge Functions → catalog-sync → Logs, last 12 hours**. Look for `AUTH_REQUIRED`,
`OAUTH_APPROVAL_REQUIRED`, boot errors, or simply no invocations at all.

## Step 2 — the decision tree

| What (a)–(d) and the logs show                                        | Cause                                                                                                                                      | Fix                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron.job` empty, or `active = false`                                 | the schedule was dropped                                                                                                                   | re-run the tail of `supabase/migrations/20260907140000_catalog_progress_keeps_its_lease.sql`: `select cron.schedule('wishly-catalog-sync', '10 seconds', $cron$select private.invoke_catalog_sync_worker()$cron$);` |
| cron runs, `net._http_response` has nothing new                       | `invoke_catalog_sync_worker()` returned `null` → a Vault secret is missing or < 32 chars                                                   | restore `wishly_catalog_sync_url` (the function URL) and `wishly_catalog_sync_secret` in Vault; the secret must byte-equal the function's `CATALOG_SYNC_SECRET`                                                     |
| `net._http_response` shows `401`                                      | Vault secret and `CATALOG_SYNC_SECRET` diverged                                                                                            | set both to one freshly generated value (≥ 32 chars) — Vault first, then the function secret, then confirm a tick succeeds                                                                                          |
| `net._http_response` shows `503` + logs say `OAUTH_APPROVAL_REQUIRED` | `DRIVE_OAUTH_MODE` is not `verified` while `WISHLY_SITE_URL` is set (see `evaluateDriveOAuthGate` in `supabase/functions/_shared/auth.ts`) | set `DRIVE_OAUTH_MODE=verified` on the project                                                                                                                                                                      |
| logs show the function claiming and failing                           | a real Drive/credential fault                                                                                                              | read the `last_error_code` in (f) and follow it; `NEEDS_REAUTH` means the owner must reconnect                                                                                                                      |
| `net._http_response` shows timeouts                                   | the worker exceeds 60 s per invocation                                                                                                     | check `catalogSyncBudgetMs()` against the `timeout_milliseconds := 60000` in `private.invoke_catalog_sync_worker()`                                                                                                 |

**Do not "fix" this by rewriting the worker.** Every piece of code in the path was working at
05:00 UTC the same morning and is unchanged since. This is configuration state, not code —
unless the logs prove otherwise.

## Step 3 — prove it is fixed

1. `select count(*) from public.team_catalog_events where event_kind = 'upserted' and occurred_at > now() - interval '5 minutes';` must be non-zero.
2. `get_drive_connection_status` on "Test team" (`31567295-49ac-4a46-9740-3519cc9c9677`) returns
   to `synced` with a fresh `last_synced_at`, and its file count returns to 621 / 180 folders.
3. DreamTeam (`e7bbca1c-a7b1-494a-8f38-d13f13961345`) starts producing `upserted` events and its
   tree fills.
4. Tell the owner. He is watching this in the browser.

## Step 4 — close the silent-failure hole (this is the real bug)

The outage was invisible for hours because every failure mode above writes nothing anywhere.
At minimum:

- `private.invoke_catalog_sync_worker()` must not `return null` mutely — raise a warning or
  record the refusal, so `cron.job_run_details` shows it.
- Add a staleness check the product can see: a space in `scanning` whose newest
  `catalog_sync_jobs.updated_at` is older than a few minutes is stuck, and
  `get_team_storage_health` should say so instead of reporting `indexing` forever.
- The UI offers no retry while a first scan is stuck — the owner had no way to act.

## Step 5 — the connection-row bug

Make `get_drive_connection_status` and `get_team_storage_health` agree on which connection is
current (one ordering, and prefer detaching the previous connection when a new root is
connected). Otherwise a space keeps showing a stale failure chip forever.

---

## Rules for whoever picks this up

- **Branches.** `main` is at `0d3b06a` (2026-09-14). The working tree is on
  `023-catalog-updater-restitch` with uncommitted work — leave it alone. Feature 022
  (`022-video-catalog-sheet`) is released and must not be touched. 021
  (`021-design-system-redesign`) carries an unmerged `NAME_CONFLICT` fix for library
  processing; it still needs to reach production.
- **Never `supabase db reset`** against the beta — it wipes the space with no backup. Migrations
  go through `npx supabase migration up --local` plus SQL tests.
- **Weak machine.** Check `uptime` first; one heavy process at a time; never `npm run verify`
  (use `--form=fast`); vitest with `--pool=forks --poolOptions.forks.singleFork=true`.
- **Production writes.** Restoring a secret or a cron schedule is a production change. Say what
  you are about to do and get the owner's yes before doing it.
- Repo files are written in English; talk to the owner in Ukrainian.
