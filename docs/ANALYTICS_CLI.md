# Wishly Analytics CLI

A local, **read-only** command-line tool for querying Wishly product analytics
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
npm run analytics -- user someone@example.com

# Machine-readable JSON (for the coding agent)
npm run analytics -- compressor --days 7 --json
```

Everything after `--` is passed to the CLI. Run `npm run analytics -- --help`
for the built-in reference.

## Commands

| Command        | What it returns                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overview`     | Users (total/new/active), sessions, events, tool opens, batches, videos, and top locales/platforms/app & agent versions.                                                                                         |
| `compressor`   | Compressor funnel + sizes: unique users, opens, videos added, started/completed/failed, started-without-completion, batches, total/average sizes, saved bytes, success rate, average saving %, average duration. |
| `users`        | Total/new/active users and the most recently active users.                                                                                                                                                       |
| `top-users`    | Ranking of users, `--by compressions` (default) or `--by activity`.                                                                                                                                              |
| `user <email>` | Full all-time detail for one user: ids, registration, last login/activity, sessions, tool usage, compression count, and a recent-events timeline.                                                                |
| `tools`        | Per-tool opens, unique users, starts, completions.                                                                                                                                                               |
| `events`       | Breakdown by `event_name`: count and unique users.                                                                                                                                                               |
| `funnel`       | Compressor conversion funnel by unique users: tool_opened → videos_added → compression_started → compression_completed, with conversion rates.                                                                   |

### Options

| Option         | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `--period <t>` | `today`, `7d`, `30d`, `90d`, or `all`. Default `7d`.                  |
| `--days <n>`   | Rolling window of N days. Overrides `--period`.                       |
| `--by <field>` | `top-users` only: `compressions` (default) or `activity`.             |
| `--limit <n>`  | Row limit for list commands (default 10; `user` timeline default 20). |
| `--json`       | Emit only stable JSON. Without it, a human-readable table is printed. |
| `-h`, `--help` | Show usage.                                                           |

Period windows: `today` starts at UTC midnight; `7d/30d/90d` and `--days N` are
rolling windows ending "now"; `all` has no lower bound. The end bound is
exclusive.

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

The CLI reads two objects in the production `public` schema:

- **`analytics_events`** — the first-party, allowlisted product event stream
  (`event_name`, `session_id`, `tool`, `properties` jsonb, `app_version`,
  `agent_version`, `locale`, `platform`, `created_at`). Defined in
  `supabase/migrations/20260718211000_analytics.sql`.
- **`analytics_users`** — a privacy-scoped view over `profiles` (+ `auth.users`
  for last-login only) created by
  `supabase/migrations/20260719130000_analytics_readonly.sql`. Exposes id, email,
  display name, language, plan, account status, registration, last activity, and
  last login — no auth secrets or raw metadata.

Event and property semantics (per-video vs per-batch, allowed property keys) come
straight from the analytics migration and `apps/web/src/analytics/`.

## Security

Read access is layered so writes are impossible:

1. **Dedicated role.** A least-privilege `wishly_analytics_ro` Postgres role with
   `LOGIN`, no superuser/createdb/createrole, and only `SELECT` on
   `analytics_events` and `analytics_users`. It has **no** INSERT/UPDATE/DELETE
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
