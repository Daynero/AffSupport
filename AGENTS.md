# Agent guide

Instructions for coding agents working in this repository.

## Soty Analytics

When the user asks about statistics, analytics, users, or usage of Soty —
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
npm run analytics -- team-workspace [--period ...] [--json]
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
| Is one build or platform less reliable?                  | `cohorts --cohort-by local-app-version                                                     | platform | web-build`and`errors` |
| Which features are seen but not learned?                 | `features`                                                                                 |
| Team pilot onboarding/find/weekly activation health?     | `team-workspace` → `data.sc001` / `data.sc005` / four separate `data.sc009.windows`        |

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

## Verifying a change

```bash
npm run verify           # static gates and the suite — about a minute
npm run verify:release   # adds the builds, release contracts and database tests
```

Both run every gate through `scripts/verify-all.mjs` and report one
machine-readable result, written to `verification-result.json` whichever form
ran. The two forms differ **only** in which gates run, never in how a result is
reported — there is one code path, and `--form` chooses a list. Success prints
at most twenty lines; a failure prints at most a hundred, naming the gate and
quoting the tool's own words rather than a paraphrase of them.

The same command runs in CI (`.github/workflows/verify.yml`) on every pull
request, across macOS, Windows and Linux — so a green run locally and a green
run there mean the same thing. `--gates=<group>` runs one phase group, which is
how the CI jobs split the work.

A gate that hangs fails rather than holding the command open, and each carries
its own timeout.

## Soty development builds

When the user asks for a dev build, test build, or installable build without
touching production, run:

```bash
npm run package:dev:dmg
```

Do not edit the production version or stable manifest, create Git tags or GitHub
Releases, push Supabase migrations, or deploy Cloudflare. Return the generated
path under `release/dev/`. The build is isolated as Soty Dev on port 43130
with local dev auth and analytics disabled. If packaging reports that Soty Dev
is busy, do not kill it; tell the user to finish the active work first.

## Soty beta staging environment

Beta is not the same thing as a dev build, and the difference matters. **Soty Dev**
is for working on the app: it fakes sign-in (`VITE_LOCAL_DEV_AUTH=true`) and
leaves the entitlement gate unenforced. **Beta** is for verifying the app before
release: it authenticates for real against a local Supabase stack and enforces
the entitlement gate with its own keypair. Never copy the dev script's auth flag
into anything beta — it would silently make the environment useless for the one
job it exists to do.

```bash
npm run beta:doctor   # prerequisites + isolation, all problems in one pass
npm run beta:up       # local stack + agent (43140) + web (5175), loopback only
npm run beta:down
npm run beta:reset    # clean baseline + fixtures; refuses a non-local target
npm run beta:package  # packaged beta build; refuses production side effects
npm run beta:verify   # packaged smoke; writes the promotion record on success
```

Beta never writes `stable.json`, never creates a tag, and never touches
production versions, migrations, or Cloudflare. Nothing reaches production
without a packaged-beta verification record for that exact commit — the
promotion gate is chained into `deploy:web*` and `package:mac`.

Invitations are **not** delivered in beta: they bypass the local mail catcher
and would reach real recipients, so no delivery credential may be configured and
the invitation link is surfaced in the UI instead. Full details in `docs/BETA.md`.

## Soty production releases

Production releases are a fixed, two-platform procedure. Follow the **Canonical
agent runbook** in `docs/PRODUCTION.md` in order; do not substitute commands,
skip gates, or invent a parallel release flow. If a canonical command fails,
fix the command or pipeline, repeat the affected gate, and record the fix. Do
not bypass it with a manual artifact.

Non-negotiable rules:

- The commit packaged for release must already be on both `main` and `beta`, and
  `beta:package` plus `beta:verify` must have succeeded for that exact SHA.
- Run heavy local build/package commands with `nice -n 15`, one at a time. The
  machine may be thermally constrained; never launch macOS and Windows-local
  build work concurrently.
- Run Windows `publish=false` and wait for its full smoke test **before** making
  the tag/release. Use `npm run release:watch -- <run-id>`; never use
  `gh run watch` or rapid polling because repeated logs waste context and do not
  make the workflow faster.
- Windows `publish=true` is the only canonical way to attach the `.exe`. Never
  upload a locally assembled or build-only Windows artifact.
- The production entitlement private key must not enter CI and must never be
  regenerated as a workaround. Windows smoke uses an ephemeral isolated key;
  the workflow then rebuilds the published installer with the tracked
  production public key.
- Sign `stable.json` from the exact assets downloaded/published on GitHub. A
  manifest-only commit does not justify rebuilding release binaries, but it
  does require a new exact-SHA beta package/verify before web deployment.
- Do not move the tag, replace published assets, change the version, or rerun a
  heavy build merely to troubleshoot monitoring. Stop and inspect the failed
  job or command first.

## Cross-platform agent code

Soty ships on macOS and Windows from one codebase. Every OS-specific mechanism —
data locations, executable names, archive handling, file-manager actions, process
suspension, name sanitization — lives in `apps/agent/src/platform/platform.ts`,
and nothing else under `apps/agent/src` may read `process.platform` or
`process.arch` (enforced by `no-restricted-syntax` in `eslint.config.mjs`; the
only other exception is `files/picker.ts`, the native-dialog implementation).

When a feature exists on one platform only, declare it as a capability rather
than branching: add the flag to `PlatformCapabilities`, map it in
`apps/agent/src/server/capabilities.ts`, and gate the route with
`hasCapability(...)` returning `501` and a stable machine code. The agent then
advertises only what the host can actually serve, and the web UI hides the rest.

## Local resource budget (power throttle)

Every heavy child process the agent spawns runs inside one shared CPU budget,
owned by `PowerGovernor` (`apps/agent/src/power/governor.ts`). The user sets a
single ceiling — 20–100% of the machine, default 100% — from the power control
in the web header, and it applies to **all** local tools at once rather than to
each separately.

**Adding a local tool.** Spawn through `apps/agent/src/power/spawn.ts`
(`spawnManaged` when you hold a governor, `spawnTracked` for a deep call site),
never `node:child_process` directly. `@typescript-eslint/no-restricted-imports`
in `eslint.config.mjs` enforces this; the allowlist is the platform and power
modules plus four files that spawn sub-second probes and native dialogs. A tool
that goes through the seam is inside the budget with no further work — that is
the whole point, because the twentieth spawn site is where a convention gets
forgotten.

**Never suspend a child yourself.** The governor duty-cycles managed children
(suspend/resume on a 200 ms period) to hold the limit, so a second suspender
would fight it and whichever resumed last would silently win. If you need a
child stopped for your own reason, take `governor.hold(child, reason)` and
release it. Before terminating a child — every cancel and shutdown path — call
`governor.resumeForTermination(child)`: `SIGTERM` is not delivered to a stopped
process, so skipping this turns a graceful stop into a `SIGKILL` and loses the
tool's output. The compressor queue's estimate-prioritization pause is the
worked example.

**Scale wall-clock deadlines.** Throttling deliberately makes work take longer.
Any real-time budget covering managed work must go through
`governor.scaleTimeout(ms)`, or a limit manufactures timeout failures whose
symptom points nowhere near the control that caused them. Already wired:
`landing-preview/renderer.ts`, `landing-preview/scanner.ts`,
`team-bridge/landing-gallery.ts`, and the queue's `SIGKILL` escalation.

**100% must mean "exactly as before".** At the maximum setting the budget yields
`null` for threads and priority, and `scaleTimeout` is the identity. Never
derive an "equivalent" value there: it would hand FFmpeg a `-threads` flag it has
never received and push whisper from `max(4, cores - 2)` to a full core count,
changing behaviour for every user who never opens the control.

**Windows.** `capabilities().processPause` is now true on win32, backed by a
resident PowerShell helper calling `NtSuspendProcess`/`NtResumeProcess`
(`apps/agent/src/platform/windows-suspend.ts`). It starts lazily on the first
suspend, so a machine that never throttles never spawns it.
