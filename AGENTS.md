# Agent guide

Instructions for coding agents working in this repository.

## Wishly Analytics

When the user asks about statistics, analytics, users, or usage of Wishly —
**do not ask them to open Supabase and click around, and do not write ad-hoc
SQL by hand.** Use the local, read-only analytics CLI instead.

Workflow:

1. Pick the analytics command that matches the question (table below).
2. Run it with `--json` so you get stable machine-readable output.
3. Read the JSON and answer the user in plain language with the numbers.

The CLI is read-only by construction (dedicated SELECT-only Postgres role, forced
read-only transactions, and a SQL guard that refuses anything but `SELECT`). It
cannot and must not modify production data. Never try to make it write.

### Commands

```bash
npm run analytics -- overview   [--period today|7d|30d|90d|all] [--json]
npm run analytics -- compressor [--period ... | --days N] [--json]
npm run analytics -- users      [--period ...] [--limit N] [--json]
npm run analytics -- top-users  [--by compressions|activity] [--period ...] [--json]
npm run analytics -- user <email> [--json]
npm run analytics -- tools      [--period ...] [--json]
npm run analytics -- events     [--period ...] [--json]
npm run analytics -- funnel     [--period ...] [--json]
npm run analytics -- onboarding [--period ...] [--json]
npm run analytics -- updates    [--period ...] [--json]
npm run analytics -- errors     [--period ...] [--limit N] [--json]
npm run analytics -- friction   [--period ...] [--json]
npm run analytics -- features   [--period ...] [--json]
npm run analytics -- journey <email> [--limit N] [--json]
npm run analytics -- run <uuid> [--json]
npm run analytics -- diagnose <error-fingerprint> [--json]
npm run analytics -- cohorts [--cohort-by local-app-version|platform|web-build] [--json]
npm run analytics -- retention  [--period ...] [--json]
```

Default period is `7d`. `--days N` gives a rolling N-day window and overrides
`--period`. Every JSON response is `{ ok, command, generated_at, period, data }`
(or `{ ok: false, command, error }` on failure).

### Which command answers which question

| User asks (any language)                                 | Command                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| How many videos compressed today / 7d / all time?        | `compressor --period today` / `--days 7` / `--period all` → `data.total_videos_compressed` |
| How many `compression_completed`?                        | `compressor` → `data.compression_completed` (or `events`)                                  |
| How many unique users used the compressor?               | `compressor` → `data.unique_users`                                                         |
| How many `compression_started` never completed?          | `compressor` → `data.started_without_completion`                                           |
| Who is the most active user? / top 10 users?             | `top-users --by activity` or `--by compressions`                                           |
| What did user@example.com do? / their compression count? | `user user@example.com`                                                                    |
| New users this week? Active users day/7d/30d?            | `overview --period 7d` / `users --period 30d`                                              |
| Most popular locale / platform / app_version?            | `overview` → `data.top_locales` / `top_platforms` / `top_app_versions`                     |
| Which tools are used most?                               | `tools`                                                                                    |
| Event breakdown / counts by event_name?                  | `events`                                                                                   |
| Conversion funnel of the compressor?                     | `funnel`                                                                                   |
| General product health for a period?                     | `overview`                                                                                 |
| Why could a user not complete a task?                    | `journey <email>`, then `run <uuid>` or `diagnose <fingerprint>`                           |
| Are users stuck installing, pairing, or updating?        | `onboarding`, `updates`, and `friction`                                                    |
| Is one build or platform less reliable?                  | `cohorts --cohort-by local-app-version|platform|web-build` and `errors`                    |
| Which features are seen but not learned?                 | `features`                                                                                 |

### Examples

- "Скільки відео стиснули за останні 7 днів?" →
  `npm run analytics -- compressor --days 7 --json` → report `data.total_videos_compressed`.
- "Хто найактивніший?" →
  `npm run analytics -- top-users --by activity --period 30d --json` → name the top row.
- "Що робив user@example.com?" →
  `npm run analytics -- user user@example.com --json` → summarize sessions, compressions, recent events.

If the CLI reports `ANALYTICS_DATABASE_URL is not set`, tell the user to follow
the one-time setup in `docs/ANALYTICS_CLI.md`; do not fall back to manual Supabase.

Do not change production data during analytics queries.
