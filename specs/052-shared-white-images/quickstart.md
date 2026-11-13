# Quickstart: validation052

**Scope**: source implementation is isolated in `feature/052-shared-white-images` and excluded from the nearest release. Local scripts/tests now exist. No command here authorizes provisioning, publication, T0 or customer cleanup. Provider/platform steps are future explicitly planned acceptance against owned dev/beta fixtures; never production backdating or customer content.

## Prerequisites

1. Реалізовані [tasks](./tasks.md), Node22.12–24, local Supabase running, Docker і чинні npm deps. Shared побудований з reviewed source; робоча копія acceptance відповідає exact source/config.
2. Тестові2000 зображень/метаданих у disposable DB; provider fixtures — лише isolated beta R2/Worker domains із окремими runtime secrets. Усе може бути synthetic; не завантажувати user content із production.
3. Немає чужої heavy verification: один child одночасно, nice15, один test worker і measured headroom. Не зупиняти dev/beta app заради тестів. Не передавати credentials у command line/artifacts.

## Local gates

Виконувати послідовно, не паралельно:

```bash
nice -n 15 npm run build -w @video-compressor/shared
nice -n 15 ./node_modules/.bin/vitest run tests/catalog-global-contract.test.ts tests/catalog-global-allocation.test.ts tests/catalog-global-confirmation.test.ts tests/catalog-global-cutover.test.ts tests/catalog-global-retirement.test.ts tests/catalog-global-diagnostics.test.ts --maxWorkers=1
nice -n 15 npm run test:db
nice -n 15 npm run verify
```

До commit потрібен verify; перед release — verify:release й чинний exact-SHA beta acceptance за канонічним runbook. Фактичні gates мають включати новий Worker build/typecheck/tests і нові PostgreSQL tests; не окремий локальний gate, який CI не знає.

## US1 + US5 — Усі settings і producers

- Pre-T0 fixture має власні white images, legacy false flag, ціни/тексти, restitch start/end screens і чинний каталог.
- Activate fixture policy за [cutover contract](./contracts/cutover-cleanup.md) тільки у disposable DB/owned beta. Новий і наявний user на hosted/installed macOS/Windows не бачить gallery/upload/Drive/prompt/fallback URL/refreshImages у workspace/defaults/profile/bulk/undo/Create/Launch.
- Text/price/schedule/video/restitch settings працюють. Create/Launch не читає private inventory. Old mixed payload/старий bundle не обходить server fence, відмова до side effects.
- Manual/scheduled/retry/growth/non-video updates навіть за старого refreshImages=false записують весь набір із global pool. Pairing із refreshTexts=false перевірено, impossible mapping має conflict без fake-success.
- Existing recipe frozen, Launch child і material мають одну catalog identity, after-reply-loss retry не створює інший набір/каталог.

## US2 + US6 — Provider і ready-ahead

Read-only isolated checker (set exact `CATALOG_GLOBAL_PROVIDER_CONFIRMATION=beta:<origin>` in the environment):

```bash
nice -n 15 node scripts/verify-catalog-global-provider.mjs --manifest /absolute/owned-beta-fixtures.json --output /tmp/catalog-global-provider.json
```

The script accepts only owned dev/beta manifests and bounded same-origin URLs, with exact target confirmation and no deletion operation. It verifies immutable public bytes/MIME/nosniff, redirect refusal and observed cache headers for three aliases. Actual canonical cache fanout, recursive routing, wrong-token/env/GET/HEAD provider behavior, browser, installed-platform and Meta acceptance need separately captured evidence; local HMAC/Worker tests do not establish live provider behavior. The report leaves these unverified and cannot unlock T0.

A delivery manifest contains `environment`, `ownedFixture:true`, `origin`, `sourceSha`, `routingRevision`, and1..10 `images` with `id`, `sha256`, `mime`, `size`, and three `urls`. Never commit token URLs or credentials with the report.

Import is operator-only using authenticated bounded setup tool; ordinary team manager cannot import/revoke private or global images after T0. One failed source remains explicit partial; no new logical image/counter on exact reimport. Current+2 aliases ready before allocation; unavailable candidates skipped before freeze, no per-row GET in create. Meta control import evidence recorded separately; absent evidence means unverified, never inferred from public GET.

## US3 — Issued and confirmed

- Allocate401 new catalog+image pairs: slots1–200=A,201–400=B,401=C. Inject failed/canceled/unknown provider writes: slots never recycle, committed totals contain only proven pairs.
- Concurrent independent DB connections around199/200/201; no duplicate pair/slot, no global lock/wait for provider commit. Repeat same intent/same image in200 rows: one assignment, exact URL, confirmed delta≤1.
- Confirm4999→5000→5001, all counters decimal-string exact and no image blocking. Team delete does not erase anonymous aggregate; historical/expired evidence explicit.

## US7 — Controlled clock and cleanup

- Fake clock atT0−1/T0/T0+29days/delete_after. Never backdate production. Manifest targets known legacy owned keys; global/video/previews/restitch/original fixtures are protected controls.
- Before deadline, old managed URLs readable despite hidden settings, removed team or legacy orphan/revoke attempt. Redeploy/login/rollback preserves T0/hold.
- At deadline, cleanup becomes eligible; use the existing durable purge worker. Retry after crash/lost DELETE/purge reply preserves unknown; quota credit only after verified finish exactly once. Manifest survives team cascade.
- Check deleted/pending/unknown/external_untouched independently. Paused old catalog not refreshed may lose old managed image after grace; originals/permissions remain untouched. No schema DROP/down migration in this phase.

Read-only provider retirement observations use the same script with `--phase retirement-before` or `--phase retirement-after`. The manifest has `retirement.deleteAfter`,1..10 `managed` v1 fixtures and1..10 `protected` controls, each with opaque `id`, `url`, `size`, `sha256`. Managed v1 URLs must use the main owned origin; protected controls may additionally use up to4explicit `retirement.protectedOrigins` HTTPS origins, for example the separate owned video domain. Before-phase refuses a due deadline; after-phase refuses an early deadline. Preserved controls require exact bytes, due retired public URLs require404/410. A404 alone never proves origin deletion, CDN purge or quota settlement: the report leaves those receipts unverified. Controlled-clock/native SQL and transport regressions cover recovery and once-only settlement; actual provider retirement remains T067.

## US4 — Agent-readable result

Using local/beta analytics configuration through the same SELECT-only role:

```bash
npm run analytics -- global-images --json
npm run analytics -- global-images --at-least 5000 --limit 50 --sort uses --json
npm run analytics -- global-images --cleanup --json
npm run analytics -- audit --period 30d --json
```

Use fixture image/flow IDs with `global-images --image`, `inspect`, `investigate` per diagnostics contract. Compare authoritative receipts with status, missing/delayed terminal, disabled client analytics, lost joins, current/as-of and cursor_stale. Output must not contain private URLs/paths/content/provider payloads; public preview only in owner status projection.

## Performance acceptance

```bash
nice -n 15 node scripts/benchmark-catalog-global.mjs --output /tmp/catalog-global-benchmark.json
```

Runner owns disposable PostgreSQL from schema/roles only using the isolated DB seam, seeds2000 synthetic ready assets, accepts no remote URL/credentials argument and cleans its container. The fixed full cohort is100samples per size100/200 and concurrency1/10, plus warmups. The report measures fresh unrestricted DB allocation p50/p95/p99/failures and one call per catalog. Separate tests cover deadline/busy/replay/rotation; actual lock-wait distributions, heterogeneous frozen-fact latency, Edge transport and whole-operation baseline/overhead remain unmeasured. Actual local authenticated Edge candidate cohort supplements direct DB benchmark; hosted browser/provider timings are separate and required before release.

Targets: warm batch p95≤250ms, e2e overhead p95≤1s for both100/200; caller deadline1s, no per-row calls/R2byte reads/sleep or preparation wait. Each size/concurrency pair has≥100 samples; include ready rotation, busy candidate and foreign unknown, and report cold/missing-proof/exhausted/failure cohorts without silently removing them. A failing target is a gate failure to fix, not a claimed measured success.

## Artifacts and release

Store sanitized source/config/environment-bound outputs under `validation/`; capture actual commands, supported/skipped platforms, counts/denominators, failure/missing evidence, diagnostic parity and budget measurements. No credentials/token URLs/file content. Existing verification-result.json remains single gate-report path; feature artifacts supplement it.

Full release uses docs/PRODUCTION.md and docs/RELEASE-CHANNEL.md, current beta/next/promote gates, archived Worker bytes/config/probe evidence and explicit validated production intent. No release, provisioning, T0 or cleanup command is executed merely because this document exists. T0 activation proof and old-client fence tested before production; after active rollback retains server fence/timer, and deleted legacy bytes are not restored.

## Review regression additions

- Reuse old assigned URL after24h and several rotations/config/key changes via inherited fresh asset/health proof; never inline GET or new URL.
- Sparse required bucket outside first sample, exhausted/locked sample -> temporary unavailable, not false pairing conflict; same-pair concurrent intents increment issued once.
- Already claimed legacy DELETE/CDN purge before preparation: activation waits for positive reconciliation, including lost replies.
- Drive-only/external-only space with zero R2 publications: metadata_unlinked at deadline, external_untouched count, no provider DELETE/permission change; global complete only after all typed targets terminal.
- Owner transfer during grace and transfer+team-delete: credit current charged ledger exactly once, original-owner snapshot is audit-only.
- Current and archived prior rollback build both hide controls under active policy. Missing compatibility baseline blocks T0; testing does not publish it.
- Cursor fingerprint mutation/TTL: at most one current-report restart, then explicit partial result without infinite loops or mixed snapshots.
