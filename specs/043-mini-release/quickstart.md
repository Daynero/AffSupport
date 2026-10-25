# Web mini-release quickstart

Only clean committed candidates qualify. Agent/shared/build dependencies/config/function changes are refused. DB changes require the explicit narrow DB workflow below. Normal full release remains available unchanged.

```bash
npm run release:web -- --check
npm run beta:verify:web
npm run release:web -- --deploy
npm run release:web -- --report
npm run release:web -- --reconcile
npm run rollback:web
npm run rollback:web -- --confirm
```

`--check` reads eligibility/prerequisite names; it does not build or publish. `beta:verify:web` (equivalently release:web --verify-only) creates an exact-source/config/package/bundle proof without publishing. `--deploy` uses a matching fresh proof or runs verification first, preserves the signed channel and publishes only the verified snapshot; existing production activation/authorization gates still apply. `--report` reads the last local outcome. After an ambiguous upload, all web writes (including full deployment/rollback) remain blocked by a shared repository marker. `--reconcile` performs read-only exact live readback against the frozen archive and requires the prior upload process group to be gone. It clears uncertainty only if every check passes. A missing process identity, different/partial live deployment, or stale owner needs manual inspection under the production runbook; never delete evidence or repeat upload speculatively. There is no automatic rollback.

## Prerequisites

An unchanged signed stable channel and published agent assets; exact candidate in beta; real local beta auth/entitlement/fixture services; an already prepared sealed beta package. New provenance records are made by normal beta packaging and independently checked by full beta verification. Older metadata-only packages cannot qualify: prepare and verify beta once from the exact clean base using the canonical BETA runbook. The web-only command itself never builds installers or rewrites that full verification record.

Verification builds source twice for distinct beta/production environments, once per configuration. Only production bytes attested by the proof are uploaded. Beta candidate UI runs against the unchanged packaged agent, real Supabase login and enforced entitlement; bundled old UI or API-only smoke is insufficient.

## Host safety and reports

One heavy child, nice 15, one test worker, 1024 MiB Node heap (2048 MiB only for the static/compiler gate with ≥25% measured memory headroom), two native threads, sequential network readback. Measured disk <3 GiB, memory headroom <15%, or load >2×cores stops new work. The tool never kills unrelated processes or automatically removes a stale lock.

Private `release/automation/web-only-report.json` and `web-only-verification.json` contain source/config/artifact IDs, checks/outcomes and bounded failure diagnostics. Public `.well-known/wishly/web-release.json` identifies the new web; existing typed analytics/support use VITE_WEB_BUILD_ID. A verified deployment/control does not prove a particular user's issue resolved without relevant observations.

Recovery compares local, archived and live signed manifest bytes and the exact target before upload. A different agent channel or tampered/missing archive blocks it; no migration or automatic down action exists. An ambiguous rollback upload or failed history write retains its writer lock for manual provider/archive inspection; no automatic stale-lock removal or retry is permitted.

## Development validation

Central targeted tests and serial npm run verify do not publish. Missing real beta/native prerequisites remain not-run/blocked in implementation evidence. The broad future schema-v2/DB/isolated-executor work is documented in the full backlog; the following additive DB slice is separately validated.

## Web plus additive DB mini release

Use PostgreSQL 17+ and a dedicated production release connection in `SOTY_MINI_DATABASE_URL`, supplied through local secret configuration. Never reuse `ANALYTICS_DATABASE_URL`, put credentials in command arguments, or save them in a draft/report. The target must match the active production binding. Pinned Supabase CLI 2.117, a running local Supabase schema/role source and Docker are rehearsal prerequisites.

Install the pinned rehearsal CLI once without changing application dependencies:

```bash
npm install --prefix release/automation/mini-db-tools --no-save --package-lock=false supabase@2.117.0
```

Supported SQL is limited to nullable builtin columns with no defaults/constraints and plain nonunique btree indexes on safe builtin scalar columns of ordinary `public` tables. Unknown SQL/hooks/ledger shape, functions/RLS, data changes, table creation, custom types/collations/opclasses, partition/inheritance and incompatible changes refuse. No agent rebuild or version bump occurs.

```bash
npm run release:web -- --plan-db
# Use the exact draft path printed by the command throughout this attempt.
npm run beta:verify:web -- --backend-plan="/absolute/path/from-plan.json"
npm run release:web -- --deploy --backend-plan="/absolute/path/from-plan.json"
npm run release:web -- --report
```

`--plan-db` only reads production and writes a private local draft under `release/automation/mini-db/`. Verification rehearses baseline → official migration A versus mini A → next full CLI migration B in an owned one-CPU/512-MiB disposable container. It copies schema/role definitions without application rows/passwords and pins official ledger statement tuples to committed SQL source. It requires the real local beta schema to equal the planned after-state; prepare beta through its canonical workflow if needed, as mini verification never resets or migrates the running beta stack. Real browser/packaged-agent checks and critical feature acceptance still apply.

The combined proof binds exact source, target, before/after history/catalog, rehearsal, beta schema, unchanged sealed agent and web bundles. Keep the same draft for verification/deployment. Drift or an expired/mismatched proof blocks; regenerate/reverify instead of editing evidence.

After the first DB mini release, use this same DB workflow for later pure web hotfixes until a full agent release absorbs the baseline. The unchanged agent tag still predates the migration paths. A fresh draft may contain zero pending migrations: verification adopts the exact already-applied state read-only and deployment performs no empty DB apply or history replay.

Explicit deploy preserves existing activation gates, commits all approved DDL and official ledger inserts in one bounded transaction, confirms the result independently, then uploads the verified web bytes. A later upload failure leaves the additive DB phase committed. Web rollback restores web bytes only; there is no DB down action.

After an unknown DB outcome, every web/backend writer remains blocked:

```bash
npm run release:web -- --reconcile-db
```

This command reads exact state and the recorded session; it never reapplies SQL. Only proven committed/aborted results clear DB uncertainty. Partial/changed state, missing evidence or a live owner requires inspection under the production runbook. Never delete a pending marker, replay the migration or run down SQL. Web upload uncertainty uses the separate `--reconcile` command.

Local outcomes and private plan/rehearsal/session evidence provide bounded release diagnostics; central analytics does not observe transaction commit. Missing real DB/beta/browser evidence remains blocked, and manual critical feature checks must be recorded. Implementation and unit fixtures do not authorize production deployment.
