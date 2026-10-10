# Soty Analytics CLI

A local, **read-only** command-line tool for querying Soty product analytics
directly from your terminal or coding agent. It exists so you (and the coding
agent in Rider) can answer questions like _"how many videos were compressed this
week?"_ without opening Supabase, clicking through filters, or writing SQL by
hand.

It is **developer-side tooling only**. It is never imported by the web app, never
shipped in any bundle, and holds no product logic — it only reads aggregates.

- No admin dashboard, no AI, no LLM, no chat, no UI. Just a CLI.
- Read-only by construction (see [Security](#security)).

## Quick start

```bash
# Human-readable tables (default)
npm run analytics -- overview
npm run analytics -- compressor --days 7
npm run analytics -- top-users --by compressions --period 30d
npm run analytics -- team-workspace --period all --json
npm run analytics -- user someone@example.com

# Machine-readable JSON (for the coding agent)
npm run analytics -- compressor --days 7 --json
```

Everything after `--` is passed to the CLI. Run `npm run analytics -- --help`
for the built-in reference.

## Commands

| Command                       | What it returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`                    | Users (total/new/active), sessions, events, tool opens, batches, videos, and top locales/platforms/app & agent versions.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `compressor`                  | Compressor funnel + sizes: unique users, opens, videos added, started/completed/failed, started-without-completion, batches, total/average sizes, saved bytes, success rate, average saving %, average duration.                                                                                                                                                                                                                                                                                                                                                       |
| `users`                       | Total/new/active users and the most recently active users.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `top-users`                   | Ranking of users, `--by compressions` (default) or `--by activity`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `user <email>`                | Full all-time detail for one user: ids, registration, last login/activity, sessions, tool usage, compression count, and a recent-events timeline.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tools`                       | Per-tool opens, unique users, inputs, starts, completions, failures, and cancellations. Every local tool reports its own queue, so the columns mean the same thing in every row.                                                                                                                                                                                                                                                                                                                                                                                       |
| `events`                      | Breakdown by `event_name`: count and unique users.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `funnel`                      | Compressor conversion funnel by unique users: tool_opened → videos_added → compression_started → compression_completed, with conversion rates.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `onboarding`                  | First-run, install, pairing, and first-tool funnel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `updates`                     | Update prompt, download, draining, restart, completion, and failure stages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sync <team-id\|owner-email>` | 028: every catalog sync job of one space, grouped by connection with its canonical feed job: kind, phase, state, age, last progress, attempts/lost leases, what a finished scan waits for, and the error code with its detail. Read from the whitelist view `analytics_catalog_sync_jobs`; never cursors, tokens or Drive names.                                                                                                                                                                                                                                       |
| `errors`                      | Error clusters by code, stage, fingerprint, tool, and local-app version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `friction`                    | Sessions that opened without input, never started, never reached an outcome, or failed without recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `features`                    | Feature impressions, interactions, successful operations, and unique users.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `journey <email>`             | Ordered per-user diagnostic timeline with builds, installation, session, flow, run, and sanitized properties. Bounded by `--period` (default `30d`; `--period all` for everything). `data.events` + `data.delivery_lag_ms`.                                                                                                                                                                                                                                                                                                                                            |
| `run <uuid>`                  | Complete ordered timeline for one operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `inspect <id>`                | 031: one attempt across every tool, oldest first — every event carrying the id as `run_id`, `flow_id`, or the `attempt_id`/`workflow_id` property. Adds `stages {expected, observed, missing}` from the coverage registry, `terminal {event, outcome}`, `last_proven_stage`, `delivery_lag_ms`, and the agent identity seen. Unknown id → `{ found: false }`.                                                                                                                                                                                                          |
| `diagnose <fingerprint>`      | All matching occurrences of one normalized error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cohorts`                     | Success/failure comparison by local-app version, platform, or web build (`--cohort-by`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `retention`                   | Registered users active again after 1, 7, and 30 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `team-workspace`              | Aggregate-only SC-001 onboarding and SC-005 find cohorts plus four independent, root-relative SC-009 team-week rates, and `data.storage` (011: connections, index completions, previews ready, attention by reason). Empty denominators are `insufficient`; weak weeks are never averaged away.                                                                                                                                                                                                                                                                        |
| `audit`                       | 031: the coverage registry (`scripts/analytics/coverage-registry.ts`) against the period — each capability `covered` / `partial` / `uncovered` / `declared_but_never_emitted` with its missing stages, orphan starts, unknown error codes per tool, delivery-report counters, web builds without link events, and `findings[]` with stable ids. `--write` saves `specs/031-platform-autoanalytics/analysis/<as_of date>.json`.                                                                                                                                         |
| `connection`                  | 032: the browser ↔ Agent link. Users with a lost link, losses and recoveries, time-to-recover p50/p95, recovery mode (auto / manual / local copy), failed checks by reason, "blocked by the browser" by browser family, page origin cohorts, `link_inconsistency` counts, and which web builds emit link events at all (`data.coverage`).                                                                                                                                                                                                                              |
| `investigate <id>`            | 033: one user's problem in one call. `<id>` is an email, `installation_id`, `run_id`, `flow_id` or `attempt_id`; default `--period 30d`. Returns `subject` (kind and opaque ids, never the email), `environment`, `sessions`, `operations` (failed / unfinished / cancelled runs rebuilt by `inspect`), `link`, `errors`, `journal_around_failures` (agent journal ±2 min around each failure), `sync` (summary of spaces the user owns), `coverage.blind_spots`, and ranked `findings[]` (`fact` / `hypothesis` / `insufficient`) with evidence and `code_locations`. |
| `journal <id>`                | 033: the agent's diagnostic journal records the web forwarded (`agent_journal_records`) for an email, `installation_id` or `agent_instance_id`, oldest first (the newest `--limit`, default 200, when there are more): category, code, props, agent run, `recorded_at`, `received_at`, lag. Default `--period 30d` (the journal is kept 30 days).                                                                                                                                                                                                                      |

### Options

| Option            | Meaning                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--period <t>`    | `today`, `7d`, `30d`, `90d`, or `all`. Default `7d`.                                                                                                                         |
| `--days <n>`      | Rolling window of N days. Overrides `--period`.                                                                                                                              |
| `--by <field>`    | `top-users` only: `compressions` (default) or `activity`.                                                                                                                    |
| `--limit <n>`     | Row limit for list commands (default 10; `user` timeline default 20).                                                                                                        |
| `--cohort-by <v>` | `local-app-version` (default), `platform`, or `web-build`.                                                                                                                   |
| `--as-of <iso>`   | Any command: fix the window's end to this instant (`created_at <= as_of`). Echoed as `period.as_of`. A bare date means UTC midnight; anything else → `{ ok: false, error }`. |
| `--write`         | `audit` only: save the artifact to `specs/031-platform-autoanalytics/analysis/<date>.json`.                                                                                  |
| `--json`          | Emit only stable JSON. Without it, a human-readable table is printed.                                                                                                        |
| `-h`, `--help`    | Show usage.                                                                                                                                                                  |

Period windows: `today` starts at UTC midnight; `7d/30d/90d` and `--days N` are
rolling windows ending "now" (or at `--as-of`); `all` has no lower bound. The
end bound is inclusive so a window pinned with `--as-of X` contains X itself;
for a window ending "now" the difference is a millisecond nobody can observe.

### Repeatable analysis (`--as-of`)

A diagnosis the agent will re-run must see the same rows twice. `--as-of
2026-10-10T00:00:00Z` fixes the end of the window to that instant for every
query the command runs, including `run`, `inspect` and `diagnose` (which have no
lower bound). Rows created after it are invisible even if they describe earlier
events, so a run whose terminal was delivered late is an orphan in that snapshot
and whole in the next.

### `delivery_lag_ms`

Every aggregating command (`overview`, `compressor`, `tools`, `events`, `funnel`,
`onboarding`, `updates`, `errors`, `friction`, `features`, `cohorts`,
`retention`, `team-workspace`, `connection`, `journey`, `audit`) carries
`data.delivery_lag_ms: { p50, p95, samples }` — `percentile_cont` over
`created_at − occurred_at` in milliseconds across the period's events. A p95 of
minutes says the client buffered offline; `samples: 0` gives `null`s, never
zeros. `inspect` computes the same statistic over the one attempt's rows.

Because `delivery_lag_ms` needs a home, the commands that used to return a bare
array now return an object: `tools → data.tools`, `events → data.events`,
`funnel → data.stages`, `onboarding`/`updates → data.stages`, `errors →
data.clusters`, `friction → data.signals`, `features → data.features` (+
`data.unsupported`), `cohorts → data.cohorts` (+ `cohort_by`, `note`), `journey
→ data.events`. Object-shaped commands only gained the field.

### `unsupported_by_producer`

The coverage registry knows which events a client actually emits today. A
signal whose evidence nobody emits is returned as
`{ "status": "unsupported_by_producer", "events": [...], "note": "..." }` in
place of a number, so a zero is never read as "it never happened":

- `updates`: every stage after `update_started` (`update_download_completed`,
  `update_verification_failed`, `update_deferred_busy`, `update_draining_started`,
  `update_restart_started`, `update_completed`, `update_failed`) — the Agent performs
  them and has no analytics client. Completion is proven by a later `agent_connected`
  with a newer `local_app_version`.
- `onboarding`: the legacy names `install_detected`, `local_app_check_*`,
  `local_app_launch_clicked`, `onboarding_started`, `onboarding_step_completed`,
  `onboarding_skipped`, and `pairing_*`.
- `friction`: `update_not_completed` (needs `update_completed`).
- `features`: `data.unsupported` lists `feature_help_opened` and `feature_disabled`.
- `cohorts --cohort-by local-app-version`: rows without a local app version are the
  cohort `no_agent_context` (browser-only screens, before pairing), not `unknown`;
  `data.note` says so.

`audit` reports a capability as `declared_but_never_emitted` when a CLI metric
still computes from such an event; SC-014 wants that count at zero. The one
documented exception today is `team_preview_completed`, which `team-workspace`
counts as SC-009 discovery while no call site emits it.

### JSON shape

Success:

```json
{
  "ok": true,
  "command": "compressor",
  "generated_at": "2026-07-19T18:00:00.000Z",
  "period": { "token": "7d", "start": "2026-07-12T18:00:00.000Z", "end": "2026-07-19T18:00:00.000Z", "label": "last 7 days" },
  "data": { "unique_users": 12, "total_videos_compressed": 84, "success_rate": 0.95, ... }
}
```

Failure:

```json
{ "ok": false, "command": "user", "error": "No user found for \"x@y.com\"." }
```

The exact `data` fields per command are defined in
[`scripts/analytics/types.ts`](../scripts/analytics/types.ts) — that file is the
source of truth for the JSON contract.

## Where the data comes from

The CLI reads these objects in the production `public` schema:

- **`analytics_events`** — the first-party, allowlisted product event stream
  Event v2 adds idempotent event IDs, occurrence time and ordering, installation,
  flow/run IDs, web and local-app build identities, platform/architecture,
  per-tool contracts, and normalized errors. Raw files, paths, content, and logs
  remain excluded. Defined by the original analytics migration and
  `20260720130000_analytics_v2.sql`.
- **`analytics_users`** — a privacy-scoped view over `profiles` (+ `auth.users`
  for last-login only) created by
  `supabase/migrations/20260719130000_analytics_readonly.sql`. Exposes id, email,
  display name, language, plan, account status, registration, last activity, and
  last login — no auth secrets or raw metadata.
- **`analytics_team_workspace`** — an aggregate-input view for explicitly enrolled pilot
  teams. It exposes only a one-way opaque workspace key, member identity needed to join the
  event stream, membership dates, root-relative dates/state, and pilot interval. It excludes
  team names, emails, file/folder/Drive ids, metadata, content, provider payloads and secrets.

Event and property semantics (per-video vs per-batch, allowed property keys) come
straight from the analytics migration and `apps/web/src/analytics/`.

## Security

Read access is layered so writes are impossible:

1. **Dedicated role.** A least-privilege `wishly_analytics_ro` Postgres role with
   `LOGIN`, no superuser/createdb/createrole, and only `SELECT` on
   `analytics_events`, `analytics_users`, and the privacy-scoped
   `analytics_team_workspace` view. It has **no** INSERT/UPDATE/DELETE
   grant anywhere.
2. **Forced read-only.** The role has `default_transaction_read_only = on`, and
   the CLI additionally opens every connection with
   `-c default_transaction_read_only=on`.
3. **Fixed queries.** The agent chooses a _command_, not raw SQL. Every query is
   a hand-written, parameterized `SELECT` in `scripts/analytics/queries.ts`.
4. **SQL guard.** `assertReadOnlySql()` rejects anything that isn't a single
   `SELECT`/`WITH`, and refuses `INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/…`
   or multi-statement input — a backstop against future edits.

No `service_role` key and no `postgres` superuser are used. The connection string
lives only in `.env` (gitignored); nothing secret is committed.

## One-time setup

Everything except the two secret-touching steps is already done in the migration.

### 1. Apply the migration

Authorize the Supabase CLI once, then push migrations:

```bash
npx supabase login          # interactive — run this yourself in the terminal
npx supabase link --project-ref <your-project-ref>
npm run analytics:migrate   # == npx supabase db push
```

This creates the `analytics_users` view, the `wishly_analytics_ro` role, its
grants, and the read-only RLS policy on `analytics_events`. The role is created
**without a password**, so it cannot log in until you set one.

### 2. Set the role's password

Pick a strong password and set it once. Easiest path — Supabase Dashboard →
**SQL Editor**:

```sql
alter role wishly_analytics_ro with password 'PUT-A-STRONG-PASSWORD-HERE';
```

(Or Dashboard → **Database → Roles → wishly_analytics_ro → set password**.)

### 3. Build the connection string

In Supabase Dashboard → **Connect** → **Session pooler**, copy the connection
string. It looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Replace the user and password with the read-only role and the password you just
set (note the `.<project-ref>` suffix is required by the pooler):

```
postgresql://wishly_analytics_ro.<project-ref>:<your-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

### 4. Add it to `.env`

```bash
ANALYTICS_DATABASE_URL=postgresql://wishly_analytics_ro.<project-ref>:<your-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

`.env` is gitignored. That's it — `npm run analytics -- overview` now works.

> If your network can reach IPv6, the **Direct connection**
> (`db.<project-ref>.supabase.co:5432`) also works; there the username is just
> `wishly_analytics_ro` (no `.<project-ref>` suffix). The Session pooler is
> recommended because it is IPv4-friendly.

## Adding a new metric

1. Add a `SELECT` query (parameterized, read-only) to
   `scripts/analytics/queries.ts`, or extend an existing one. Reuse the
   `EVENTS_RANGE` predicate and `rangeParams(period)` for time windows.
2. Add its result type to `scripts/analytics/types.ts` (keep JSON field names
   stable — agents depend on them).
3. If it's a new command, wire it into the dispatch `switch` in
   `scripts/analytics/index.ts` and add a `format*` renderer in
   `scripts/analytics/format.ts`.
4. Add a case to the PGlite-backed test in `tests/analytics-queries.test.ts`
   (it runs the real SQL against an in-process Postgres — no Docker needed) and
   run `npx vitest run tests/analytics-queries.test.ts`.
5. If it exposes a new column/table, extend the grants in the
   `20260719130000_analytics_readonly` migration.

Keep everything `SELECT`-only; the `assertReadOnlySql` guard will reject writes.

### Team workspace metric semantics

`team-workspace` uses only parameterized `SELECT` queries. SC-001 is a fixed 20-attempt
cohort and passes at 18 successful, fully completed onboarding flows within five minutes.
SC-005 is a fixed 20-attempt cohort, five attempts per GEO/offer/language/category cue, and
passes at 18 unaided exact finds within 30 seconds.

SC-009 returns weeks 1–4 separately from each enrolled team's root connection. A team-week
enters the denominator only when the pilot interval covers the window start, the latest root
is not detached, at least two members were active at the window start, and the event stream
contains an authenticated workspace session during that week. The numerator additionally
requires both discovery (successful find or useful preview) and production (successful file
operation or returned workflow). A zero denominator is `insufficient`. `all_windows_pass`
is false if any week fails, null if none fail but any is insufficient, and true only when all
four pass. The command's final privacy guard refuses identifying fields or values before JSON
is printed.

### Coverage audit and attempt inspection (feature 031)

`audit` compares `scripts/analytics/coverage-registry.ts` — every capability with its
start/terminal events, correlation id, readiness and error events, platforms,
unobservable stages and producer status — with the period's events:

- `covered`: a start and a terminal observed, carrying the same `run_id` / `flow_id` /
  `attempt_id` / `workflow_id` at least once.
- `partial`: `missing` lists what did not arrive (`terminal`, `start`, `readiness`,
  `start_correlation`, `terminal_correlation`, `correlated_pair`).
- `uncovered`: no event of the capability in the period. `producer_status` tells a
  blind spot (`unsupported_by_producer`) from an unused or broken producer (`emitted`).
- `declared_but_never_emitted`: a metric input with no producer anywhere.
- `orphan_starts`: start ids that met no terminal in the period; `samples` is the
  number of start events.
- `unknown_codes`: per tool, failure rows whose `error_code` / `error_stage` resolved to
  `unknown` (SC-015 wants `error_stage ≠ unknown` for ≥ 95%).
- `delivery`: sums of `analytics_delivery_report` counters (`rejected`, `evicted`,
  `expired`) and `by_event` splits; `reports: 0` means losses are unknown.
- `uncovered_builds`: web builds that emitted no link event (same shape as
  `connection.coverage`).
- `findings[]`: ordered by severity; `id` is `sha256("<capability>|<status>|<sorted
missing>")`, so a repeated audit of the same snapshot yields the same ids and
  `--write` produces byte-identical files (SC-017). `team.sync` is read from the
  authoritative view `analytics_catalog_sync_jobs`, not the event stream.

`inspect <id>` matches `run_id` and `flow_id` as columns and `attempt_id` /
`workflow_id` as properties (the `attempt_id` column arrives with the envelope v3
migration; until then only the property is read, and `agent.agent_instance_id` is
`null` with a note). The capability is inferred from the registry by the start/terminal
events (and `tool`) the rows carry; `stages.expected` lists the stages that have event
evidence, `observed` the ones proven by a row, `last_proven_stage` the furthest of them,
and `terminal` the latest terminal row with its outcome. Properties pass through the
client's own allowlist (`ANALYTICS_PROPERTY_KEYS`), as do `journey`, `run` and
`diagnose`.

### Connection metric semantics (feature 032)

`connection` reads the seven link events a 032 web build emits —
`link_check_started`, `link_check_completed`, `link_lost`, `link_recovered`,
`reconnect_clicked`, `blocked_by_browser_detected`, `link_inconsistency` — plus the
`pairing_*` properties they share. Everything is an aggregate; no user, session,
installation or instance id is returned.

- `users_with_loss` / `losses` / `recoveries` count `link_lost` and `link_recovered`.
- `recovery_ms.p50` / `p95` are `percentile_cont` over `duration_ms` of `link_recovered`
  (how long the break lasted; the client clamps it to one day); `samples` says how
  many recoveries carried a duration. Both are `null` with no samples.
- `recovery_mode` splits recoveries into `auto`, `manual` (the person clicked
  "Reconnect") and `local_copy` (the page was reopened from the Agent's own origin).
- `failed_checks_by_reason` groups `link_check_completed` with outcome `failure` or
  `blocked` by `link_reason` (FR-012 vocabulary); `unknown` is a real bucket.
- `blocked_by_browser` counts distinct users per `browser_family` on
  `blocked_by_browser_detected`; `origins` is the `hosted` / `local_copy` cohort over
  every link event that carries `link_origin`.
- `inconsistencies` counts `link_inconsistency` — the stream said open while a request
  said 401/403/connection failed. It is the headline indicator of the 032 bug class.
- `coverage.web_builds_without` lists the web builds seen in the period that emitted no
  link event at all. They predate 032 or lost analytics; the list is there so a zero
  elsewhere is read as "not observed", never as "no breaks". Pair this command with
  `journey <email>` to see one person's attempts in order.

### Investigation and agent journal semantics (feature 033)

- **Subject.** An email resolves through `analytics_users` and is never
  printed. A uuid is tried as a `run_id`, `flow_id`, `installation_id` (events,
  then journal) and user id, in that order; any other opaque id as an
  `attempt_id` / `workflow_id`. A run, flow or attempt investigates its user
  and lists that operation first. Nothing matching → `{ ok: false }`.
- **Bounds.** Events are read by `created_at` within the period (newest 5000),
  journal records by `received_at <= end` and `recorded_at >= start − 2 min`.
  `--as-of` pins both, so a repeated investigation returns the same `data`.
- **Operations.** Rows are grouped by `run_id`, else `workflow_id`, else
  `attempt_id`; groups that did not end in success (at most 25) are rebuilt
  with `inspect` (stages, chain, terminal). `error_code` / `fingerprint` come
  from the group's `error_occurred`; a failure without one reads `unknown`.
- **Journal around failures.** Records within ±2 min of a failed or unfinished
  operation, an `error_occurred` outside an operation, a failed `tool_ready`
  or a `link_lost`, matched by the failure's agent instance (or installation).
  Props are re-checked against the server fence of `ingest_agent_journal`.
- **Findings** (sorted by severity, then fact → hypothesis → insufficient,
  newest first; `id` = sha256 of rule and key):
  - `failed_operation_code` — fact: a failed run with a code; stage, code and
    code locations of `<tool>:<stage>:<code>`.
  - `failed_operation_unknown_with_journal` — hypothesis: a failed run without
    a code with notable journal records near it (spawn/picker failures,
    restarts, stream evictions, auth refusals, drain); cites `journal:<category>:<code>`.
  - `failed_operation_unknown` — insufficient: no code and no journal.
  - `journal_tool_failure` — fact: `spawn:exited` `nonzero`/`spawn_error`, or
    `picker:exit` `failed`/`unavailable`/`timeout`, or `picker:visibility_unknown`
    within ±2 min of a failure.
  - `unfinished_operation` — hypothesis: a run with no terminal.
  - `error_event` — fact (insufficient for `unknown`): `error_occurred` outside a run.
  - `tool_ready_failure` — fact: `readiness:<stage>:<code>`.
  - `link_lost_unrecovered` — fact: `link_lost` with no later `link_recovered`
    of the same flow in the period; `link_manual_recovery` — fact (low);
    `pairing_rejected_repeated` — fact when ≥ 2 rejections.
  - `stale_agent` — hypothesis: the user's latest local app version is older
    than the newest any user ran in the period.
  - `no_events` — insufficient: nothing from this subject in the period, with
    the blind spots as evidence; `journal_missing` — insufficient (low):
    failures but no journal record.
- **Blind spots.** `no_events_in_period`, `analytics_disabled` (account
  active, no events), `web_build_without_link_events`,
  `agent_version_without_journal`, `agent_journal_missing`,
  `analytics_delivery_losses`, `sync_unavailable`, `journal_table_missing`,
  `envelope_v3_missing` (see schema detection below).
- **Code map.** `scripts/analytics/code-map.ts` maps every
  `<tool>:<stage>:<code>` of the closed lists, every `journal:<category>:<code>`
  the agent writes, every `link:<reason>`, `readiness:<stage>:*`, `team:<stage>:*`
  and `agent:stale_version` to files and a check sentence; lookups fall back
  to `<tool>:<stage>:*`, then `<tool>:*`.
- **Privacy.** `investigateOutputIsPrivate` refuses any address, URL,
  credential or path in the output, except repo-relative source files in
  `code_locations[].files`; both commands fail closed when it does.

### Schema detection (databases before the 031/033 migrations)

The CLI can run ahead of the migrations it reads. Once per process,
`scripts/analytics/schema.ts` runs one read-only `information_schema` query
(bound parameters) for the envelope v3 columns of `analytics_events`
(`attempt_id`, `agent_instance_id`, `agent_platform`; migration
`20261117110000`) and the tables `agent_journal_records` (20261124100000),
`analytics_daily_events` / `analytics_daily_tool_outcomes` (20261120100000)
and `analytics_catalog_sync_jobs`. `information_schema` only lists what the
role can read, so an object without a grant counts as missing. Each query then
picks one of two fixed SQL fragments — `attempt_id` from
`coalesce(e.attempt_id, properties)` or from `properties` alone; the Agent
instance and platform as the column or `null` — and skips journal or sync
reads entirely when the table is absent. Nothing typed by a user is ever
interpolated. What the commands say about it:

- `investigate` and `audit` carry `data.schema` (`events`, `tables`,
  `missing`). `investigate` adds the blind spots `envelope_v3_missing` (values:
  the missing columns), `journal_table_missing` (and then does not claim
  `agent_journal_missing` / `agent_version_without_journal`, which would mean
  "readable but empty") and `sync_unavailable`.
- `journal` returns `ok: true` with
  `data: { available: false, reason: 'journal_table_missing', records: [] }` —
  unknown, not "no records".
- `inspect` adds `data.schema` (`missing`, `note`) when an envelope v3 column is
  missing; Agent run ids and platforms are then empty because they are unknown.
- `audit` adds `data.schema.note`, and reports the sync capability as
  `uncovered` with `missing: ['analytics_catalog_sync_jobs']` when the view is
  not visible.

Tests build both schemas: `createAnalyticsDb({ schema: 'pre-031' })` in
`tests/support/analytics-pglite.ts`, exercised by
`tests/analytics-schema-compat.test.ts`.

## Legacy media inventory (feature 030)

`scripts/restitch-bucket-inventory.mjs` lists what the two legacy Storage buckets still hold
(`team-restitch-images`, `team-thumbnail-cache`), grouped by space and by publishing member,
as one JSON document on stdout. It uses the Storage API with the service key and only ever
lists; nothing is removed or written. Its output is the input to the approved object list in
`supabase/migrations/20261105100000_restitch_bucket_retirement.sql`.

```sh
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/restitch-bucket-inventory.mjs > inventory.json
```

Pass `--bucket team-restitch-images` to list one bucket. The service key is read from the
environment for the one call and is never written anywhere.
