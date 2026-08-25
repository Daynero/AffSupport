# Audit Findings — Release Hardening Pass

**Created**: 2026-08-23
**Method**: Four independent parallel code audits (agent lifecycle, test infrastructure, security surface, web state/design/performance), plus live HTTP probing of the running beta stack (agent `127.0.0.1:43140`, web `127.0.0.1:5175`) at commit `78f1d88`.
**Status**: Inventory. This file is the evidence behind `spec.md`. It is not the boundary of the work — anything found during implementation is appended here under the same format.

Each finding carries an ID used by `spec.md` SC-019. Severity: **H** high, **M** medium, **L** low.
`FR-xxx` links the finding to the requirement it motivates.

**Confidence — read this before acting on any finding.**

- Findings quoting a `file:line` were read directly and can be checked by opening that line.
- Findings quoting an approximate range (`~332-360`) or a count without a listing ("41 files", "72 unused keys", "31 tables", "197 functions", "24 `!important`") are **derived from searches whose exact commands were not preserved**. Reproduce the count as the first step of any task that depends on it; treat the number as an estimate, not a fact. Specifically: **A6** carries no line anchor at all, and **C1**'s central claim ("no code path ever checks `artifacts.*.sha256`") is a negative that was not exhaustively proven — it is the highest-priority security item, so prove it before designing around it.
- **Section D, and the interface halves of E and F, were produced by reading source and probing the HTTP surface. No finding in them was observed in a browser** — the Chrome extension was unavailable during this audit (see G6). **D1 in particular — the loudest conclusion in this document — has never been seen happen.** Confirm D1–D6 by hand in a browser before building against them. The live HTTP probes in G5 _were_ executed and their results are facts.
- **D10 is a hypothesis, not an observation.** The endpoint count and the protocol version are facts; the causal link to the user's reported symptom is inference and is labelled as such where it appears.

---

## A. Run lifecycle and state machines

### Topology

There is no single job engine. Five independent in-memory state machines, each with its own live-update channel, plus one cross-cutting resource authority underneath all of them at the spawn seam.

| Subsystem              | File                                                   | Status type                                                               | Persisted    | Live channel                  |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------ | ----------------------------- |
| Compressor             | `apps/agent/src/queue/queue.ts` (1670 L)               | `JobStatus` (8)                                                           | `state.json` | `/api/events`                 |
| Transcription          | `apps/agent/src/queue/transcription-queue.ts` (1723 L) | `TranscriptionJobStatus` (7) + `TranslationStatus` (4)                    | own store    | `/api/transcription/events`   |
| Landing optimizer      | `apps/agent/src/landing/optimizer.ts`                  | `LandingJobStatus` (7) + `LandingJobPhase` (9) + `LandingAssetStatus` (5) | no           | `/api/landing/events`         |
| Landing preview        | `apps/agent/src/landing-preview/catalog.ts`            | `LandingPreviewItemStatus` (4) + `LandingPreviewPhase` (≥6)               | own store    | `/api/landing-preview/events` |
| Media actions (Finder) | `apps/agent/src/media-actions/queue.ts`                | own status (`:15-31`)                                                     | **no**       | **none** (polled)             |
| Power                  | `apps/agent/src/power/governor.ts`                     | `PowerState`                                                              | `power.json` | `/api/power/events`           |

Compressor states — `packages/shared/src/types.ts:1-9`: `analyzing | ready | queued | processing | completed | failed | cancelled | interrupted`. Transitions are asserted at 16 sites in `queue.ts` (`:448,455,470,480,620,646,907,950,957,969,1167,1213,1234,1257,1281,1296`). Transcription has 17 assignment sites; landing 10; landing-preview 8; media-actions 5. **No machine has a single authoritative transition table**; states are assigned inline.

**There is no resume anywhere.** `cancelled` is terminal in every machine; `retry()`/`repeat()` (`queue.ts:783,793`) delegate to `start()` and re-run from scratch. The only "pause" is `governor.hold()`, an OS-level suspend invisible to the job state — a held job still reads `processing`. → FR-008.

### Findings

- **A1 (H, FR-011)** — `throttlingSupported` can lie on Windows. `PowerGovernor.pauseSupported` is captured once at construction (`power/governor.ts:184`) from a static per-platform constant (`platform/platform.ts:44-65`). After the Windows suspend helper permanently disables itself at `MAX_FAILED_STARTS` (`platform/windows-suspend.ts:60-72`), three things go wrong silently: `PowerState.throttlingSupported` still reports `true`, so the panel claims a limit that is not applied; the duty cycler keeps calling `pauseProcess` 5×/s to no effect indefinitely; and `queue.pauseSupported()` (`queue.ts:205`) still returns `true`, so estimate prioritisation takes the early-return branch at `queue.ts:1397-1400` and **stops working for the rest of the session**. No plumbing exists for the helper to report degradation back to the governor. Spec 008 shipped the "unsupported" UI state (T078) but it is unreachable even when it should be reached.

- **A2 (H, FR-003 / FR-003a)** — Quitting mid-encode leaks a partial output file. `queue.ts:816-840` signals and escalates but never unlinks `job.outputPath`, and `store.ts:52-92` only `access()`-checks `inputPath` on load — it never removes the orphan. Every _cancel_ path does unlink (`queue.ts:1178,1183,1200,1218,1226,1237`); shutdown does not. A user who quits mid-batch accumulates truncated `.mp4` files next to their sources.

- **A3 (H, FR-005)** — Media actions cannot be stopped by the user at all. `media-actions/routes.ts:21,57,67` exposes enqueue and read only. `MediaActionQueue` has `abandoning` + `activeConversion.abort()` but they are reachable **only from `shutdown()`** (`media-actions/queue.ts:145-167`). A wedged Finder-initiated conversion holds the machine with no way to stop it. It is also the only queue with no persistence, no `interrupted` status, and no live channel — jobs vanish on restart and its `processing → completed` transition is never pushed anywhere.

- **A4 (M, FR-001)** — Compressor state is five independent fields, not one value: `compressionInFlight`, `prioritizingEstimates`, `compressionPausedForEstimates`, `activeAbort`, `active`. Every "wedged queue" defence in the file exists because of this — `startDrainWatchdog` (`:1083`), `closeBatchIfDrained` (`:1120`), the in-flight-flag-first ordering at `:1160-1163`. This is the strongest structural argument in the audit for a single explicit lifecycle.

- **A5 (M, FR-002)** — Conditionally-released estimate hold. `queue.ts:1411`: `if (pausedChild && this.active === pausedChild) this.releaseEstimateHold();`. If `pump()`'s `finally` (`:1242`) cleared `this.active` while the estimate loop was unwinding, the hold token is never released; `this.estimateHoldRelease` is later overwritten by `holdForEstimates` (`:198`) without being called. Currently masked because the child's `close` reaps the entry — but the invariant "a hold is always released by its taker" is broken, which is the exact class of bug the hold protocol was introduced to eliminate.

- **A6 (M, FR-010) — no line anchor; locate before acting** — Termination pin can never age out. `holdsTerminationPin()` increments `terminationPinCycles` only from `suspendAll`. If the limit returns to 100% or the last child deregisters while a pin is outstanding, the cycler stops and the pin never ages. Re-lowering the limit later leaves that child pinned-resumed and exempt from the throttle for its whole life.

- **A7 (M, FR-012a)** — `RENDER_CONCURRENCY` is outside the budget. `landing-preview/catalog.ts:41` computes up to 4 concurrent Chromium renders from `availableParallelism()` at module import, unconnected to the power lever. CPU share is still capped by duty cycling, but slot count — and therefore peak memory and the number of process trees walked — is not. It is the only place where a user could reasonably expect the lever to reduce parallelism and it does not.

- **A8 (L, FR-006)** — Restored-batch drain watchdog is dead code. `queue.ts:157` guards on `!this.batch.finishedAt`, but `store.ts:83` restores `finishedAt: Number(rawBatch.finishedAt) || Date.now()` — always truthy. The documented "agent died mid-drain" recovery can never fire from disk. Harmless today; the comment and the code disagree.

- **A9 (L, FR-002)** — Descendant PID recycling. `governor.ts` refreshes the process tree every 3 s; recency ≤3 s is the _only_ guard against signalling a recycled PID, and `pauseProcessId` (`platform.ts:~332-360`) has no reaped-child guard.

- **A10 (not a defect — a strength to preserve; FR-013)** — `eslint.config.mjs:97-102` bans value imports of `node:child_process` under `apps/agent/src` outside `platform/**`, `power/**`, and five named files, doubled by `tests/power-spawn-coverage.test.ts:55`. Playwright is the single hand-registered exception (`landing-preview/renderer.ts:521-534`). This is the mechanism FR-013 requires; the pass must keep and extend it, not weaken it.

- **A12 (H, FR-006) — found during planning** — Transcription reports interrupted work as failed. `apps/agent/src/queue/transcription-store.ts:118-131` deliberately maps a restarted `processing` transcription to `failed`, while the compressor maps the same situation to `interrupted` (`queue/store.ts:154-166`). FR-006 requires interrupted to be distinct from failed; transcription violates it today.

- **A13 (M, FR-020/FR-022) — found during planning** — The end-to-end harness writes into the developer's real data directory. `scripts/real-agent-check.mjs:64-69` redirects `AGENT_PORT`, `AGENT_STATE_PATH`, `AGENT_CACHE_PATH`, `AGENT_IMPORT_PATH`, `AGENT_IMAGE_PATH` — but **not** `AGENT_TRANSCRIBE_IMPORT_PATH` (`transcription/routes.ts:31`), `AGENT_TRANSCRIBE_DOCUMENTS_PATH` (`transcription/document-store.ts:18`), `AGENT_TRANSLATION_CACHE_PATH` or `AGENT_TRANSCRIBE_PREVIEWS_PATH` (`queue/transcription-queue.ts:253,257`). Any interleaving scenario touching transcription pollutes real Application Support. Blocker for FR-020.

- **A14 (M, FR-020) — found during planning** — The best existing stop test asserts Node's report, not the machine. `tests/stop-leaves-nothing-running.test.ts:46-48,53` and `:237-239,243` assert termination via the `close` event's signal argument. A bug in the escalation at `apps/agent/src/power/spawn.ts:163-192` would leave these green. This is the file the recent production stop fix landed in, and the concrete reason FR-020 is worded "the machine's actual state, not the application's report".

- **A15 (L, FR-022) — found during planning** — `scripts/real-agent-check.mjs:475-485` `availablePort()` binds port 0, closes, then reuses the number — racy by construction and materially worse on a Windows runner.

- **A16 (L) — found during planning** — `scripts/real-agent-check.mjs:69` sets `NO_OPEN: '1'`, read nowhere under `apps/`; its only consumer is `scripts/verify-dmg.sh:29`. A no-op env var in a harness reads as a guarantee that is not there.

- **A17 (M, FR-022) — found during planning, verified** — `tests/team-contract.test.ts:210-211` does not merely shell out to npm: `npm run generate:team-contract` **rebuilds `packages/shared/dist` and rewrites the tracked migration `supabase/migrations/20260801090000_team_contract_seed.sql`** while the suite runs. It mutates artefacts every other gate reads. This single fact is why the verification pipeline must run the suite exclusively against every other phase. Lasting fix: give `scripts/generate-team-contract-sql.mjs` an `--out <dir>` and have the test generate into a temp directory.

- **A19 (M, FR-022) — found during implementation, observed** — Test cleanup signalled bare pids. `tests/stop-releases-slot.test.ts` recorded the encoders it spawned as plain numbers and `SIGKILL`ed them in `afterEach`; by then those processes were expected to be gone, so the operating system was free to have handed their numbers to something else — including a Vitest worker fork. Observed as an intermittent `ERR_IPC_CHANNEL_CLOSED` that killed the run's summary roughly once in three full-suite runs. Fixed by recording `(pid, creationTime)` handles and going through `survivorsOf` before signalling. Worth recording because it is the exact hazard `tests/support/machine-probe.ts` carries a creation time to avoid, reintroduced in cleanup code that nobody thought of as observation.

- **A18 (L, FR-022) — found during planning, observed** — `tests/transcription-auto-translation.test.ts` is flaky under full-suite load: observed failing with `ENOTEMPTY: rmdir .../cache`, passing in isolation. A concrete instance of B7's copy-pasted `mkdtemp` + `rm` cleanup, not a new class.

### Lifecycle transitions with no test

Verified against the whole suite. Assertion density on compressor statuses: `ready` 116 hits / 42 files, `completed` 89/23, `queued` 49/18, `processing` 44/17, `failed` 32/20, `cancelled` 18/7, **`interrupted` 4/3**, **`analyzing` 1/1**.

- **A11 (H, FR-019)** — Untested transitions: `processing → interrupted` (neither in-memory nor the `store.ts:154-166` disk migration); `JobQueue.shutdown()` mid-encode (the escalation race, A2, and the job staying `processing`); `cancelAll()` on the agent side (only the UI is covered, `tests/compressor-stop-all-ui.test.tsx:62`) including its queued-before-processing ordering guarantee and `closeBatchIfDrained()`; cancel during `preparing-images` (`queue.ts:665` abort path and the `isCancelled` branch at `:1220-1224` that must not overwrite `cancelled` with `failed`); the audio-copy fallback re-run (`queue.ts:1195-1208`) including a cancel between the two runs; recovery re-probe branches (`queue.ts:448-455`, `:475-480`); batch teardown demoting siblings (`:1296`); the `input-analysis → analyzing` branch of `pauseForRuntimeFailure` (`:1281`); transcription `cancelAll()`/`stopJobSideWork` (`transcription-queue.ts:1386-1420`); `TranslationStatus.failed` (`:727`); landing cancel-vs-fail decided by the `this.cancelling` flag; landing phases `rewriting` and the `preparing → ready → queued` head; `LandingAssetStatus.skipped` (`optimizer.ts:824`); landing-preview re-queue-after-failure (`catalog.ts:647,840`) and ready-from-cache (`:833`); the entire `MediaActionQueue` (no test file exists); A1's Windows degradation; A6's pin ageing.
- **No test enumerates any state machine exhaustively.** A table-driven transition matrix sourced from the union type — so adding a state breaks the test — is the single highest-value artifact this pass can produce.

### Already delivered by spec 008 — do not re-specify

83/87 tasks complete. The 4 open ones are manual QA walkthroughs with no code: **T084** (macOS quickstart §3-6), **T085** (SC-005 subjective trial), **T086** (Windows quickstart §7, including the kill-the-agent-mid-job orphaned-suspended-process check, which its own tasks.md calls "the most consequential failure mode in the design"), **T087** (edge cases §8, time-to-task §9). 008's 14 invariants each name a test and each test exists. Its declared edge cases already cover: limit changed mid-job, rapid lever movement, low-core floor, agent disconnected, agent too old, external load, multi-window, queued-while-limited, sleep/wake.

**These four manual walkthroughs are exactly what FR-020 requires be automated.**

---

## B. Test infrastructure and automation

205 test files (`tests/*.test.ts` 141 + `tests/*.test.tsx` 64; `ls tests | wc -l` reports 208 because three support files carry no `.test` infix), 1403 tests. **32 s wall clock** for the whole suite; ~85 s of summed per-worker test time, of which ~40 s is jsdom environment setup — the two figures differ because the default forks pool runs files in parallel. The suite is not the bottleneck; orchestration and prose output are.

### Findings

- **B1 (H, FR-017)** — **Zero CI on push or pull request.** Three workflows: `release-test.yml` is `workflow_dispatch` only (`on: { workflow_dispatch: {} }`, macos-15, Node 22, runs `npm test && npm run build:web`); `release-windows.yml` triggers on push to the isolated `windows-beta-build` branch only; `mirror-windows-inputs.yml` is dispatch only. Nothing gates `main`. `apps/agent` is **never built by CI** (`release-test.yml:11` builds web only). `lint`/`format:check` run only in the Windows-branch `validate` job. Node version skew: 22 in one workflow, 24 in two, no `engines`, no `.nvmrc`. The constitution already names this at `.specify/memory/constitution.md:203-208`.

- **B2 (H, FR-014)** — **`tests/` and `scripts/` are in no tsconfig.** `apps/agent/tsconfig.json` includes `["src"]`; `apps/web/tsconfig.json` includes `["src","vite.config.ts"]`; `packages/shared/tsconfig.json` includes `["src"]`. There is **no `typecheck` script at all**. A test referencing a renamed field fails only at runtime, or not at all if the assertion is never reached. ESLint runs on `tests` but with the non-type-checked `tseslint.configs.recommended`, so no type-aware rules either.

- **B3 (H, FR-016)** — **Real-binary tests silently pass when the binary is missing.** `if (!available) return;` at `tests/real-ffmpeg.test.ts:18,61`; `tests/embedded-ffmpeg.test.ts:21,50,97,142,185,224` (6 sites); `tests/static-edges.test.ts:25,39,56`; `tests/long-embedding.manual.test.ts:40,131`; and `tests/soty-review-production-boundary.test.ts:12` (`if (!existsSync('apps/web/dist')) return;` — passes on a clean checkout having checked nothing). All report **green**, not skipped. Named as an anti-pattern at `.specify/memory/constitution.md:221-223` and still present.

- **B4 (H, FR-018)** — **No coverage tooling.** No `coverage` key in `vitest.config.ts`, no `@vitest/coverage-v8`/`-istanbul` in devDependencies. `coverage/` appears only in ignore lists. There is no numeric baseline to ratchet against; installing a provider and recording a baseline is step one.

- **B5 (M, FR-015)** — **No aggregator and no machine-readable result.** ~15 verify scripts across `package.json`, each printing prose. `docs/PRODUCTION.md:89-91,115-116,128,173-174,184-188` and `docs/BETA.md:190-212` describe the release pass as a hand-typed ordered list of ~10 commands, several prefixed `nice -n 15`. Measured cost of the automatable subset on this machine: build shared 1.1 s, lint 5.8 s, format:check 5.8 s, build:web 5.7 s, build agent 2.0 s, vitest 32.4 s — **~53 s total**. The remaining cost is entirely human reading. Vitest supports `--reporter=dot` (≈205 chars for the run) and `--reporter=json`; **neither is used anywhere**.

- **B6 (M, FR-015)** — Diagnostic noise on green runs. No `--silent`, no `onConsoleLog` filter. `tests/entitlement.test.ts` dumps a full OpenSSL error stack to stderr on every passing run; `tests/team-landing-gallery.test.tsx` prints a benchmark JSON blob. Both land in an assistant's context on every run.

- **B7 (M, FR-021)** — **Shared helpers barely exist.** Only three non-test support files in `tests/` (175 lines total): `helpers.ts` (compressor factories), `web-auth-helpers.ts` (one empty state), `team-space-fixtures.ts`. Everything else is reimplemented: `mkdtemp` + `afterEach(rm)` copy-pasted into **41 files**; a poll/`until` helper redefined in at least 6 test files plus `scripts/real-agent-check.mjs:487`; video/image factories in 4 places, all spawning real ffmpeg; env save/restore hand-rolled in 5 files; **no shared fake ffmpeg**, **no fake local-app harness for interface tests** (each `.tsx` test hand-mocks its client — `tests/drive-connect.test.ts` has 35 `vi.*` calls).

- **B8 (M, FR-022)** — Flakiness sources. Wall-clock assertions: `tests/catalog-benchmark.test.ts:31-33` (three `p95Ms < 2000`), `tests/creative-library-benchmark.test.ts:20,42`, `tests/team-landing-gallery.test.tsx:318-353`. Twenty real `setTimeout` sleeps against only 9 files using `vi.useFakeTimers`. `tests/power-persistence.test.ts:47` writes a **hardcoded absolute path** `/tmp/soty-power-override.json`, outside any temp directory and shared across concurrent runs. `tests/team-contract.test.ts:210-211` shells out to `execFileSync('npm', ['run','generate:team-contract'])` **twice** inside a test, regenerating SQL (most of its 7.5 s).

- **B9 (M, FR-022)** — jsdom hygiene. No `setupFiles`, so `afterEach(cleanup)` is per-file, and **14 `.tsx` files never call it**: `creative-library-bulk`, `design-components`, `landing-drop`, `launcher`, `soty-review-{accessibility,disclosure,motion,navigation,nested-flow,primary-action,reducer}`, `team-landing-render-sharing`, `transcription-modal`, `ui-workflow`. jsdom setup is 40.2 s of the 85 s of summed per-worker test time — the largest single fixed cost, though wall clock is 32 s because files run in parallel.

- **B10 (M, FR-020)** — The only real out-of-process end-to-end harness, `scripts/real-agent-check.mjs` (503 lines), is not a vitest file, produces prose, and **is run by no workflow**. It already has the right scaffolding — free-port picker and redirected state paths at `:58-80`, upload → estimate → start → wait, source-file SHA-256 immutability checks at `:171,201,264`. It is the correct foundation for FR-020, not a thing to replace.

- **B11 (M, FR-017)** — `release-windows.yml:56-70` runs vitest against a **hand-maintained list of 15 files**. Nothing asserts the list is a subset of existing files, so it rots silently as tests are renamed.

- **B12 (L, FR-053)** — Browser automation exists and is unwired: `apps/soty-review/scripts/verify-review.mjs:7,34-61` boots `vite preview` on 4174, drives headless Chromium, runs `axe-core` failing on serious/critical, plus isolation and layout checks. It is not in `npm test` or any workflow. It is the natural base for FR-053.

- **B13 (L, FR-020)** — The runtime Chromium path in `landing-preview/renderer.ts:7,491` is never exercised in vitest; `tests/landing-preview-catalog.test.ts:138` substitutes a stub renderer.

- **B14 (L, FR-022)** — `vitest` is pinned (`package.json` devDependencies; the 3.2.7 figure is from the run banner) `^3.2.4` but 3.2.7 is installed; no lockstep. `vitest.config.ts` sets only `include`/`exclude` — no environment, setupFiles, globals, coverage, testTimeout, or pool options.

### Modules with no test importing them

Agent: `files/support-dir.ts`, `files/upload-intake.ts`, `transcription/export.ts`, `index.ts` (419 lines, referenced only as a string in `tests/auth-routing-security.test.ts:251`).
Shared: `environment-runtime.ts`, `team/creative-library.ts` (555 L), `team/library-processing.ts` (351 L), `team/tasks.ts` (282 L) — reached only transitively through the barrel.
Web (~50 modules), notably **`api/useAgentEventStream.ts`** — the client half of every state transition — plus `team/useTeamRealtime.ts`, `team/useCatalogFreshness.ts`, `team/processing/useTeamOperation.ts`, `team/library/thumbnailRelay.ts`, `team/tasks/{task-drag,TaskCard,TaskStatusControl,TaskProgressScale}.tsx`, `landing-viewer/*`, `team/create/CreateSpaceWizard.tsx`, `team/lobby/SpaceLobby.tsx`, `PublicHomePage.tsx`, `pages/LegalPages.tsx`.
Scripts: `beta-down.mjs`, `dev-release-meta.mjs`, `fetch-windows-inputs.mjs`, `generate-signing-keys.mjs`, `sign-release-manifest.mjs`, `validate-team-migrations.mjs`, `watch-github-run.mjs`.

---

## C. Security

### What is already strong — protect it

`shell: false` everywhere, enforced by the ESLint ban (A10); **no `shell: true` anywhere in the repo**. Zip extraction hardened with entry/size/ratio/depth caps and lexical containment (`landing-preview/archive.ts:7-11,107-118`). `resolvePreviewAsset` does lexical **and** realpath containment (`team-bridge/preview-origin.ts:145-159`). Download destination realpath'd with `COPYFILE_EXCL` (`team-bridge/download.ts:49-50,101-113`). Every one of the 31 public tables has RLS; all 197 `security definer` functions set `search_path`; sensitive state lives in the non-exposed `private` schema; no `grant … to anon`. Telemetry has a strict 67-key property allowlist with a `safeToken` filter rejecting anything containing `/`, `\`, spaces, or non-ASCII (`apps/web/src/analytics/events.ts:216-307`) — **no file name or path can survive sanitization**. `validatePublicConfig` actively rejects a privileged key reaching the browser (`apps/web/src/lib/config.ts:41-58`). No secret was ever committed (verified via `git log --diff-filter=A`). `stable.json` is ECDSA P-256 signed over a canonical payload and verified in the browser before any URL is trusted.

### Findings

- **C1 (H, FR-028) — verify the negative claim first** — **The shipped macOS app is ad-hoc signed and not notarized; the Windows installer is unsigned.** `scripts/package-mac.sh:67-69,95` does `codesign --remove-signature` then `codesign --force --sign -`. No `notarytool`/`stapler` anywhere; no `signtool`/Authenticode in `packaging/windows-installer.iss` or `.github/workflows/release-windows.yml`. The manifest signature protects _which URL_ users are sent to; **nothing verifies the bytes that arrive** — `stable.json` records `artifacts.*.sha256` and no code path ever checks it. The chain terminates in "user right-click-opens an unsigned binary past Gatekeeper/SmartScreen", which trains users to bypass the one control that would catch a compromised release. Highest-leverage item in the security pass.

- **C2 (H, FR-025)** — **`apps/web/public/_headers` sets only `Cache-Control` and `X-Robots-Tag`.** No CSP, no `frame-ancestors`/`X-Frame-Options`, no HSTS, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy` — on the exact origin that stores the agent pairing token in `localStorage` (`apps/web/src/api/pairing-token.ts:19,81`) and the Supabase session. Any XSS or dependency compromise reads that token and, per C3, gets arbitrary local file access on every paired machine. `apps/web/index.html:29-46,52-90` ships two inline `<script>` blocks, so the CSP needs hashes or a nonce. Cheapest high-impact fix in this pass.

- **C3 (H, FR-026)** — **Three routes take an arbitrary absolute path from the request body.** `POST /api/files/add` (`compressor/routes.ts:69-81`) accepts any absolute path, reads it with ffmpeg and writes `<name>_compressed.mp4` **next to the original** (`files/paths.ts:5-29`); `POST /api/transcription/files/add` (`transcription/routes.ts:70-86`) is the same; `POST /api/landing-preview/open` (`landing-preview/routes.ts:59-73` → `catalog.openRoot`, `catalog.ts:229-231`, realpath but **no root constraint**) scans an arbitrary directory tree, renders its HTML and serves WebP renders back via `/api/landing-preview/landings/:id/image`. Together: **arbitrary local file read exfiltrated as a rendered image, plus arbitrary directory write**, for anyone holding the session token — which is in `localStorage` on an origin with no CSP (C2) and is placed in URLs (C4).

- **C4 (H, FR-024)** — **Session token compared with `!==` and accepted in the URL query.** `apps/agent/src/server/app.ts:148-150`. `/native/*` correctly uses `timingSafeEqual` (`app.ts:290-294`); the browser token does not. The query-string variant is used at ~12 client call sites (`apps/web/src/api/client.ts:155,260,263,274,278,285,336,348,352,625,768`), so the 64-hex token lands in Fastify's request log (logger default `true`, `app.ts:92`), browser history, and any `Referer` from preview-origin pages — there is no global `Referrer-Policy`, only one scoped to `/api/team/*` (`app.ts:113-117`).

- **C5 (H, FR-023)** — **No `Host` header validation anywhere → DNS-rebinding surface.** Confirmed live: `curl -H "Host: evil.example.com" http://127.0.0.1:43140/health` returns 200. The Origin check covers `/api/*` only (`app.ts:104-107`), so `/health`, `/pair`, `/local` and the served SPA are exempt; `/health` leaks `instanceId`, `startedAt`, version, capabilities and busy state to a rebound origin. `/api/*` is saved only by the Origin check, which does not fire when the browser omits Origin (same-origin GET, `<img>`, `<script>`, `EventSource`). Combined with C4, a rebound page that ever learns a token gets full API access.

- **C6 (M, FR-023)** — `!origin` is allowed at the CORS layer (`app.ts:95`) and `Access-Control-Allow-Private-Network: true` is echoed for allowed origins (`app.ts:118-124`). Any non-browser local process is trusted. Live probe confirms the positive half works: a hostile origin gets no `Access-Control-Allow-Origin` on `/health` and a 403 on a `POST` preflight.

- **C7 (M, FR-027)** — **No rate limiting anywhere.** No `@fastify/rate-limit` in `apps/agent/package.json`. Nothing throttles `/api/entitlement` (a signature-verify oracle), token guessing, or SSE connection count (`server/sse.ts:11`, an unbounded `Set`).

- **C8 (M, FR-027)** — Asymmetric size limits. `bodyLimit: 16_384` globally (`app.ts:92`) but multipart `fileSize: 100 GiB` (`app.ts:100`) applies to **every** upload route, including `/api/landing/upload/folder/file` which loops per file with no aggregate cap (`landing/routes.ts:146-180`). Only `/api/images/:slot` narrows correctly (`compressor/routes.ts:131`).

- **C9 (M, FR-031)** — `drive-transfer`'s `/range`, `/render-range`, `/thumbnail` run with `verify_jwt = false` and no `authorizeCaller` (`supabase/functions/drive-transfer/index.ts:1268-1280`), relying entirely on the grant ticket in `x-wishly-transfer-grant`. This is the one unauthenticated data path in the whole backend; grant entropy, TTL, single-use enforcement, replay window, and binding to both material and caller team need audit.

- **C10 (M, FR-024 / FR-029)** — Secrets reachable via logs. Fastify's default logger is on and logs `req.url`, which carries `?token=<64-hex>` (C4). The launcher pipes agent stdout to unified logging (`packaging/Launcher.swift:21,807-812`), readable by other admin processes.

- **C11 (M, FR-028)** — The signed manifest does not constrain the artifact host. `apps/web/src/release-manifest.ts:118-127` returns `artifact.url` verbatim; `validManifest` (`:157-173`) checks neither origin nor `sha256` shape. One misused signing key yields an arbitrary download origin.

- **C12 (M, FR-032)** — TOFU on the pairing token. `apps/web/src/api/pairing-token.ts:73-83,121-129` adopts any 64-hex `#agentToken=` fragment on first sight, persists it, and fans it out over `BroadcastChannel` (`:86-89`). Nothing proves the token came from this machine's agent. Impact is limited (a wrong token 401s) but it is a free foothold for a "re-pair now" phishing flow.

- **C13 (M, FR-030)** — `npm audit --omit=dev` run 2026-08-23 at commit `78f1d88`: **4 (3 high, 1 moderate)**; 5 in the full tree. `fast-uri` 3.1.4/4.1.1 (High, GHSA-7p8r-x3mc-p8w7 host confusion) is a **runtime dependency of the agent** via `fastify@5.10.0`. Also `brace-expansion` (High, DoS), `nanoid` (High, build-time via vite→postcss), `postcss` (Moderate, GHSA-fxqj-rqcc-2cmp), `undici` via `jsdom` (High, dev-only). All fixable without majors. `scripts/verify-release.mjs` has **no dependency check at all**.

- **C14 (M, FR-032a)** — Two shell-adjacent string builders. `files/picker.ts:116-150` builds PowerShell script text with `psQuote()` — values are static literals today, safe by accident not by construction. `files/dropped-source.ts` interpolates a **client-supplied filename** into an `mdfind` `kMDItemFSName == "…"` expression with only `\`/`"` escaping; reachable from `/api/files/upload` and `/api/transcription/files/upload` metadata.

- **C15 (M, FR-032b)** — `explorer.exe` / `open` invoked with agent-derived paths (`platform/platform.ts:153-176`), reachable from six reveal/open routes. Paths come from agent state, but that state is seeded by C3's routes. On Windows `openPath` will hand a URL or `.lnk`/`.hta` to the shell.

- **C16 (M, FR-032c)** — Import temp directories are never garbage-collected. `compressor/routes.ts:112-125` and `transcription/routes.ts:112-126` `mkdtemp` per upload; cleanup exists only on the error path, and the transcription route has none on success. Nothing sweeps `Imports/`/`TranscribeImports/` at boot. Uploaded media accumulates in Application Support forever.

- **C17 (L, FR-029a)** — Raw `Error.message` escapes to the client in `/api/diagnostics` (`server/app.ts:218-231`, via `queue.warningMessage()`) and in `landing/routes.ts:259-264` / `landing-preview/routes.ts:220-224`. For filesystem and ffmpeg failures these routinely contain absolute paths. `team-bridge/routes.ts:340-366` does it correctly by mapping to a fixed code list — that is the pattern to apply everywhere.

- **C18 (L, FR-032d)** — Mode inconsistencies: `session-token.json` and parent are 0600/0700 (correct, `session-token.ts:75-84`); `entitlement.json` uses the default mode (`entitlement/entitlement.ts:169-175`); `.env.beta` on disk is 0644 while `.env` is 0600.

- **C19 (L, FR-032e)** — `applicationSupportRoot()` honours `AGENT_SUPPORT_DIRECTORY_NAME` unvalidated (`files/support-dir.ts:24`); a value with separators relocates all agent state. `TRANSLATION_MODEL_URL` **and** `TRANSLATION_MODEL_SHA256` are both env-overridable (`translation/tools.ts:154-162`). Env-only, but note in the threat model.

- **C20 (L, FR-032f)** — `supabase/functions/_shared/cors.ts:1` hard-codes `http://{127.0.0.1,localhost}:5173` into the allowlist for production deployments. Should be environment-gated.

- **C21 (L, FR-042)** — `installedReleasePath` polls, reads and JSON-parses a file every 3 s forever with no `unref()` (`apps/agent/src/index.ts:340-352`) — the only timer in the file that is not unref'd.

### Suggested security ordering

C1 → C2 → C3 → C4/C5/C10 → C9 → C7/C8 → C11/C12 → C13 → C14/C15/C16.

---

## D. Interface state truthfulness

- **D1 (H, FR-033/FR-039) — inferred from source, not yet observed** — **A brief connection drop unmounts the compressor and transcription pages into an un-closable dialog.** `useAgentEventStream.ts:32-43` fires `onDisconnect()` on `onerror` with **no grace period and fixed 4 s retry**; `AgentContext.tsx:200` sets `connection = 'disconnected'`. `ProtectedSoty.tsx:80-81`: `capability` is `null` for both tools (`tool-registry.ts:71,107`), so `connection !== 'connected'` swaps the page for `ToolSetupScreen` → a blocking `LocalAppDialog` **with no `onClose`** (`ProtectedSoty.tsx:107`), over a blank `<main>`. `Modal.tsx:202` renders no ✕ without `closeLabel` + `onClose`, and `LocalAppDialog.tsx:146` sets `closeOnEscape={false}`. **A four-second blip traps the user in an un-closable "Download Soty" modal and wipes the queue view.** `/landing-optimizer` and `/landing-preview` (`capability: 'landing'`) keep their page mounted — **same event, two opposite outcomes**.

- **D2 (H, FR-033)** — Consequence of D1: a graceful in-page degradation already exists and is **unreachable dead code** on `/compressor` — `App.tsx:392-399` (checking spinner), `:401-410` (onboarding branch), `:415-425` (`agentDisconnected` / `restoreQueue` banner). The router gate hides it. `HomePage.tsx:122-130` also renders `<Onboarding>` whenever `!connected`, and `disconnected` falls through every branch of `App.tsx:700-777` to the generic panel at `:784`, so a momentary blip shows **"Open Soty / Download Soty"** to a user whose agent is running fine.

- **D3 (H, FR-037)** — **No sequencing between request responses and live updates.** Every mutation does `setState(await request(...))` — `App.tsx:169,183,192,223,253,279,309,332,343,359` — while the same `state` is written by `AgentContext.tsx:197` on every tick. There is no version, generation, or `updatedAt` on `QueueState`, so a slow response lands after a newer snapshot and **overwrites it with stale data**: progress jumps backwards, a completed job flips back to `processing`. Same pattern at `TranscriptionPage.tsx:203` vs `:285` and `LandingOptimizerPage.tsx:66` vs `:99`.

- **D4 (H, FR-038)** — **Re-pairing navigates the whole tab away.** `AgentContext.tsx:170-171` calls `pairWithAgent()`, which is `location.assign(...)` (`api/client.ts:106-108`). Every piece of unsaved in-page state is destroyed — toasts, open modals, and most damagingly the editable transcript in `TranscriptTextModal.tsx` (1731 lines). The autopair budget is per-tab `sessionStorage` (`api/pairing-token.ts:173,180-187`), so with three tabs open **all three navigate independently**, each burning its own budget of 2/min; the third-plus attempt drops each tab to a manual `pairing_required` screen.

- **D5 (M, FR-035)** — `AgentContext.tsx:198` sets `connection = 'connected'` on any live message. If the stream survives while the API fails — entitlement revoked mid-session, token rotated, 500s — the badge and every gate say "connected" while every action errors.

- **D6 (M, FR-036)** — Rows keep animating while disconnected. `JobRow.tsx:99` passes `active={job.status === 'processing'}` and `ui.tsx:152` turns on the `is-flowing` animation; `JobRow.tsx:519-523` keeps a 1 s `setInterval` ticking elapsed time. Neither consults `connection`. Wherever the page does stay mounted (landing, team), frozen data renders as live, ticking progress.

- **D7 (H, FR-040)** — **Fabricated progress.** `team/library/ProcessLibraryDialog.tsx:275-287` posts a **hardcoded `progress: 35, stage: 'processing'`** every heartbeat. Anyone watching the operation from another tab or as another member sees a fabricated 35% for the whole run.

- **D8 (M, FR-041)** — `App.tsx:180-188` `stopAll` computes `stopping` from the pre-call snapshot then toasts `stoppedCount`; files that finished in between are over-reported. Stop and per-job cancel (`JobRow.tsx:439-447`) are fire-and-replace with no in-flight disabled state, so the button stays double-clickable through the round trip.

- **D9 (M, FR-011)** — `lib/power.tsx:88-111` — `setLimit` optimistically sets `pending`; if the agent is unreachable it stores `deferred.current` and the lever **permanently displays a limit that is not in force**.

- **D10 (M, FR-009b) — hypothesis** — **Seven distinct live-update endpoints** — `/api/events`, `/api/transcription/events`, `/api/landing/events`, `/api/landing-preview/events`, `/api/team/events`, `/api/team/landings/events`, `/api/power/events` — over HTTP/1.1 (confirmed live), which browsers cap at 6 connections per origin. Consumers: `AgentContext.tsx:193` and `lib/power.tsx:161` are always-on; `useTeamLandings.ts:154`, `useTeamOperation.ts:75`, `LandingOptimizerPage.tsx:64`, `TranscriptionPage.tsx:197`, `agentLandingSource.ts:41` are conditional. With enough open at once the pool is exhausted and **ordinary start/stop requests queue behind streams that never end**. This is a plausible root cause for the "started something, stopped, tried to continue something else, nothing responded" class of report and is untested anywhere.

- **D11 (M, FR-009c)** — Two tabs both derive `running` from the same broadcast so they agree, but the start guard is purely client-side (`queue-ui.ts:77` → `App.tsx:491`). Nothing serializes two tabs hitting start in the same tick. `startSelected` clears selection only locally (`App.tsx:318-322`), so the other tab keeps rows visually selected against a now-running job.

- **D12 (L, FR-042)** — `addToast` schedules a `setTimeout` never cleared on unmount (`App.tsx:132-138`, `TranscriptionPage.tsx:211`, `LandingOptimizerPage.tsx:78`) → state update on an unmounted component after navigation.

- **What already works (do not regress)** — refresh-and-resume is sound: the agent persists the queue and rewrites `processing → interrupted` on restart (`apps/agent/src/queue/store.ts:156-219`), the web refetches via `connect()` → `/api/queue` (`api/client.ts:135-139`), and selection survives in `sessionStorage` (`App.tsx:55-66,154-156`).

---

## E. Performance

- **E1 (H, FR-042)** — **Unmemoized context on a ~2 Hz full-state broadcast.** `AgentContext.tsx:277-301` builds a fresh object literal every render including two fresh arrow functions, so every tick re-renders **all 11 `useAgent()` consumers** regardless of what they read — `ProtectedSoty.tsx:47` (→ Header → PowerThrottle, ThemeToggle, UserMenu, SupportButton, SotyLogo), `ProtectedSoty.tsx:68`, `HomePage.tsx:16`, `App.tsx:76`, `LocalAppDialog.tsx:25`, `ReleaseUpdateNotice.tsx:16`, `AccountPage.tsx:109`, and the three tool pages. Same defect in `AuthContext.tsx:439-450`.

- **E2 (H, FR-042)** — **`React.memo` is used exactly once in the whole app** (`TranscriptTextModal.tsx:148`). `JobRow` (650 lines, ~40 DOM nodes) is not memoized (`App.tsx:544-565`) and receives four inline arrow props recreated every render, so memoizing it today would be a no-op. Every tick re-renders every row, including completed ones whose data cannot change.

- **E3 (M, FR-042)** — `App.tsx:370-376` memoizes on `[state.jobs]`, but `state.jobs` is a **brand-new array every broadcast**, so all four `useMemo`s recompute every tick anyway; `selectedStartable`/`selectedRemovable`/`stoppable` (`:372-374`) are not memoized at all; `App.tsx:147` builds a `join('|')` over every job id every render. Same in `TranscriptionPage.tsx:226` and `LandingOptimizerPage.tsx:84`.

- **E4 (M, FR-043)** — Payload size, not just rate: the agent broadcasts a full `QueueState` clone per `notify()` (`server/sse.ts:10-40`, driven from `queue/queue.ts:1436-1439`), unthrottled and undiffed.

- **E5 (H, FR-045/FR-047)** — **901 animated SVG paths on every page.** `components/honeycomb-data.ts` is 5,436 lines / ~200 KB of `export const` arrays; `Root.tsx:35` mounts `<HoneycombField />` **unconditionally above the router** — login, legal, home, every tool page. `HoneycombField.tsx:190-224` renders all 901 as real `<path>` elements and `:231-241` gives every trace a running CSS animation. `:96-118` runs a `pointermove` rAF loop writing `style.transform` **and `style.filter = drop-shadow(...)`** on ~50 cells per frame — per-element SVG filters are among the most expensive things a browser composites, running behind a page already re-rendering at 2 Hz. The data lands in the **entry chunk**, so the login screen pays for it.

- **E6 (H, FR-045)** — Bundle. No `manualChunks`, no compression plugin, no analysis in `apps/web/vite.config.ts`. Built output: `ProtectedSoty-*.js` **481 KB**, a misnamed shared vendor chunk `ThemeToggle-*.js` **419 KB** (contains `@supabase/supabase-js`), entry `index-*.js` **362 KB** (includes the honeycomb data), `index-*.css` **226 KB**. `lib/tool-registry.ts:12-15,21-25` imports all four tool pages **statically and deliberately**, so opening the compressor also downloads the transcription page and its 1,731-line transcript modal, the landing viewer, the entire `/team` workspace, and the 852-line `AdminPage` (`ProtectedSoty.tsx:13`) that only admins can use. `components/SupportDialog.tsx:2` imports `qrcode` at module scope and `SupportButton` lives in the persistent header. 226 KB of blocking CSS is served on every route including login.

- **E7 (M, FR-044)** — **No virtualization anywhere** (zero hits for virtual/windowing; one `IntersectionObserver` at `team/library/LibraryAssetVisualPreview.tsx:61-65`). The compressor queue is a plain `.map` (`App.tsx:543-566`) and users drop **folders** of video (`DropZone.tsx:54-58`), so hundreds of 650-line rows re-rendering at 2 Hz is the normal case. `TranscriptTextModal.tsx:1320,1523` renders an entire transcript twice plus a 500 ms `setInterval` at `:528`. Also `TranscriptionPage.tsx:673`, `LandingOptimizerPage.tsx:325`, `LandingJobCard.tsx:185`, `CreativeLibrary.tsx:289`, `MaterialResults.tsx:65`, `LandingTree.tsx:36,121` (recursive).

- **E8 (M, FR-046)** — `loading="lazy"` appears in only 4 places. Missing on `ImageEmbeddingSection.tsx:401`, `TaskAttachmentTile.tsx:231,256,348`, `MaterialPreview.tsx:256`, `LibraryAssetVisualPreview.tsx:139,167`, `ImageCompareModal.tsx:74,83,94`, `LandingFullView.tsx:114`. **No `width`/`height` or `aspect-ratio` on any of them** → layout shift on every gallery. `decoding="async"` used nowhere. `LandingFullView.tsx:110-120` renders every segment image of a landing at once. `<video>` elements at five sites fetch full media for a tile — there is no thumbnail path.

- **E9 (L, FR-042)** — `AgentContext.tsx:265-267` polls the release manifest every 15 min **plus** on every `focus` and `visibilitychange`, with a loading guard but no minimum interval — alt-tabbing fires a request each time. `ui.tsx:329-330` attaches capturing `scroll` + `resize` and calls `getBoundingClientRect` synchronously per event with no rAF throttle.

---

## F. Design system, accessibility, i18n

The token system is real — `apps/web/src/styles.css:5-160` defines primitive ramps, semantic roles, `--space-1..6`, `--radius-sm..xl`, `--shadow-sm..xl`, easing and duration, a shell-width ladder (`:98-105`) and a dialog-width ladder (`:120-126`), with a full dark override at `:7999-8033` and 2,125 custom-property references. **The problem is drift, not absence** — one 13,088-line / 226 KB stylesheet with no layers and no co-location.

- **F1 (H, FR-049)** — **Undefined tokens silently falling back.** `--color-danger`: 0 definitions, 5 uses, falling back to **two different literals** — `#d64545` (`:1094,1095,1293,1553,6201`) and `#d2453f` (`:12935`) — while the real token `--color-error: #b42318` exists. Three "danger" reds ship. `--border`, `--border-strong`, `--surface`, `--surface-raised`, `--text`, `--text-muted`: 0 definitions, 8 uses; `.team-beta-storage-notice` (`:12777-12779`) and `.environment-badge` (`:12790-12794`) chain fallbacks that **all resolve to nothing** — transparent border, no background, inherited colour — under a comment at `:12770-12772` claiming they use existing theme properties. Also `--font-mono` (`:9603`) and `--color-text-subtle` (`:6036`). Wrong fallbacks that mask the real value: `var(--space-5, 24px)` at `:12655,12721` where `--space-5: 20px`.

- **F2 (M, FR-050)** — Scale drift. 441 token uses vs **345 raw-px** `gap`/`padding`/`margin` declarations, off the 4 px grid: 29× `gap: 6px`, 15× `padding: 6px`, 14× `padding: 3px`, 13× `gap: 5px`, 11× `padding: 9px`, 8× `padding: 7px`, plus 14/18/10 px. A third convention (`rem`) appears in the beta block (`:12775-12776`). Typography has no scale tokens and uses machine-generated fractional literals — `body 20.93px` (`:178`), `h1 25.42px`, `h2 22.43px`, `h3 20.93px`, `h4 16.45px` (`:224-249`), `min-height: 44.2px`, `padding-inline: 15.6px` (`:9982-9999`) — all in `px`, so browser font-size settings are ignored. **21 distinct breakpoints** including the near-duplicate pairs 1180/1179, 760/720, 520/500.

- **F3 (M, FR-050)** — **Ad-hoc z-index: 58 raw values, no scale, no comments.** `.modal-backdrop` is 100 (`:5682`) / nested 110 (`:5693`), but `.environment-badge` is 2000 (`:12789`) — above every modal, with no comment saying why. Plus 1000 (`:1867`), 1150 (`:2836`), 1200 (`:2955`), a dense 1–12 band, a 20/30/40/45/60/80/100/110/120 band, and two `z-index: -1`. _Correction after review:_ the `z-index: 10001` at `:8532` is **not** a defect — it is `::view-transition-group(theme-toggle)`, which lives in the view-transition overlay's own stacking context and is not comparable to page z-index. The comment at `:8528-8530` explains it. It is excluded from the scale.

  The requirement this motivates is that a **stacking scale be created** — there is none today — not merely that values be moved onto one.

- **F4 (M, FR-051)** — **Four modal patterns.** (1) The `Modal` primitive (`components/Modal.tsx:97-211`) — portal, focus trap, scroll lock, focus restore, Escape, nesting stack; used by 18 files. (2) **Hand-rolled** `role="dialog" aria-modal="true"` with none of that — `team/preview/MaterialPreview.tsx:198-206` and `team/landings/LandingFullView.tsx:78-86`. (3) **Native `window.confirm()`** — `App.tsx:927` (concatenating `\n`-joined filenames into an OS dialog) and `landing-viewer/useLandingViewer.ts:145,151`. (4) The `bare` escape hatch (`Modal.tsx:57`), used by the transcript viewer and image-compare, which then define their own backdrop and width (`:8836`, `:7786`), bypassing the `--dialog-*` ladder the primitive exists to enforce. Three separate dialog footers: `.inline-actions` (`:727`), `.dialog-actions` (`:6536`), `.team-dialog-actions` (`:9619` **and** `:10534`).

- **F5 (M, FR-050)** — Duplicate definitions. `.button` defined **twice** (`:860` the real one with 5 variants at `:894-955`, and `:9986-9989` overriding min-height and padding). One-off buttons outside the component: `.text-button` (`:1003`), `.platform-download-button` (`:6239`), `.google-button-loader` (`:5486`), `.tooltip-button` (`:1836`), plus `<span className="button button-primary">` as non-interactive fake buttons (`HomePage.tsx:114,178`). `.transcript-match-help` declared **three times** (`:9995,10704,10958`); ~20 other classes twice; 24 `!important`. The power module uses BEM `__` against kebab-case everywhere else (`:12925-13000`, `components/PowerThrottle.tsx:83-95`).

- **F6 (M, FR-052)** — Dark-mode gaps. Dark is one block (`:7999-8033`) plus **34 targeted per-component patches** (`:8303-8511`, `:10766-10899`) — i.e. 34 components hardcoded colours and needed fixing individually. Colours that still do not flip: `background: #fff` at `:948,4088,4412,5853,7425,7685,7699,10083,10131`; `color: #fff` at `:4502,4576`; `#2d2638` (`:1228`); `#33240a` on `#ffe59a` (`:4438-4439`); `outline: 2px solid #ffd166` (`:4105`); `#090b10` (`:10066,10078`), `#05070a` (`:10126`), `#000` (`:8899`); the whole Google button block (`:5186-5200`).

- **F7 (M, FR-057)** — `apps/web/index.html:6-27` — `<html lang="uk">`, title, description and **all OG/Twitter metadata are Ukrainian-only, hardcoded**. `i18n.ts:2882` sets `document.documentElement.lang` only after React mounts. Every English user's first paint and every social share is Ukrainian. `index.html:75-83` — the boot-recovery fallback is hardcoded Ukrainian text with hardcoded hex (`#120e1f`, `#c9c2dc`, `#f5a623`, `#1b102d`) and no light variant.

- **F8 (H, FR-053)** — **The global focus indicator fails contrast.** `styles.css:211-214`: `outline: 3px solid color-mix(in srgb, var(--color-focus) 45%, transparent)` where `--color-focus` is `#9b7aee`; at 45% over `--color-bg #f7f4fa` this is ≈`#cbb8f2`, roughly **1.5:1**. WCAG 2.2 SC 1.4.11 requires 3:1. Fails on every light-theme surface.

- **F9 (H, FR-053)** — **The whole job list is an `aria-live="polite"` region.** `App.tsx:536` wraps the list including `JobRow.tsx:104`'s percentage and the 1 s-ticking timer (`:534-537`). At ~2 broadcasts/sec × N jobs, screen readers are flooded with continuous re-announcement of the entire queue. Same at `TranscriptionPage.tsx:673` and `LandingOptimizerPage.tsx:325`. Three duplicate `ToastRegion`s (`App.tsx:901`, `LandingOptimizerPage.tsx:443`, `TranscriptionPage.tsx:1137`) are all `polite`; error toasts need `assertive`.

- **F10 (M, FR-051/FR-053)** — Focus management gaps. `Modal.tsx:22-31` `focusableIn` **misses `[contenteditable]`, `details/summary`, `audio[controls]`, `video[controls]`, `iframe`** — exactly what `TranscriptTextModal.tsx:1568` and the transcript editor contain, so Tab escapes those dialogs. The trap only fires on first/last (`:151-157`). `Modal.tsx:185` marks the backdrop `aria-hidden` but never applies `inert`/`aria-hidden` to the rest of `#root`, so background content stays in the accessibility tree. `PowerThrottle.tsx:86` sets `role="dialog"` without `aria-modal` and never moves focus into the panel. The two hand-rolled dialogs (F4) have zero focus management.

- **F11 (M, FR-053)** — Keyboard gaps. `ui.tsx:97-125` `SegmentedControl` is a `radiogroup` with **no arrow keys and no roving tabindex** — every option is its own tab stop. `JobRow.tsx:67-74` puts selection logic in `onClick` reading `event.shiftKey` with a no-op `onChange`, so **range selection is mouse-only** (and React warns about the controlled input). `HomePage.tsx:87-101,140-155` uses `<Card role="button" tabIndex={0}>` with `aria-disabled` set but still activatable, so a disconnected tool card fires anyway. `DropZone.tsx:69-80` has no keyboard equivalent for dropping. `ui.tsx:355-392` portals tooltip content to `document.body`, out of DOM order and unfocusable. `App.tsx:640-651` language buttons are raw literals with no `type="button"`, no `role`, no `aria-pressed` — the active language is conveyed by colour alone. `ui.tsx:161-162` `ProgressBar` has `aria-valuenow` but no `aria-valuetext`.

- **F12 (M, FR-054 / FR-056)** — Note before automating the unused-key check: `selectedCountKey` (`i18n.ts:2872-2878`) **builds key names at runtime**, so a purely static "unused" scan will produce false positives. Any check enforcing FR-056 must account for dynamically constructed keys. i18n is structurally sound but incomplete in practice. Two locales, **1,335 keys each, perfectly parallel** — 0 missing, 0 extra, enforced by `Record<keyof typeof en, string>` (`i18n.ts:1430`), and `TranslationKey = keyof typeof en` (`:2849`) makes a used-but-undefined key a compile error. But: **72 keys are defined and never referenced** (~5.4%), the largest cluster being 27 team keys suggesting a shipped-then-reworked flow. **Pluralization is ad-hoc and covers one string** — `selectedCountKey` (`:2872-2878`) hand-codes Ukrainian one/many for `selectedOne`/`selectedMany`; every other count (`stoppedCount`, `queuedCount`, `processingCount`, `completedCount`, `failedCount` — `App.tsx:184,890-893`) is a single form with `{count}`, which is wrong in Ukrainian. No `Intl.PluralRules` anywhere. Interpolation is `String.replaceAll` (`:2861-2870`) with no escaping and no missing-value warning.

- **F13 (H, FR-055)** — **Agent messages are localized by regex-matching English text.** `App.tsx:1003-1007` (`localizedAgentText`) and `JobRow.tsx:633-649` (`localizedJobError`) run 11 regexes against the agent's English error strings. Any copy edit in `apps/agent` silently drops the Ukrainian translation and shows raw English. Error _codes_ are handled correctly at `App.tsx:985-1001` — the agent should emit codes for these too.

- **F14 (L, FR-054)** — Untranslated literals: `team/library/CreativeLibrary.tsx:393` (`<option>Unknown</option>`), `pages/AccountPage.tsx:193` (`>English<`), `PublicHomePage.tsx:55` and `pages/LegalPages.tsx:267` (`aria-label="Legal"`), `pages/AdminPage.tsx:802`. Non-localized `document.title` on every page — `App.tsx:92`, `HomePage.tsx:26`, `TranscriptionPage.tsx:184`, `LandingOptimizerPage.tsx:50` — and `HomePage.tsx:27-29` writes an English `<meta name="description">`.

- **F15 (L, FR-054)** — `TranscriptionPage.tsx:225` defaults `settings.translationLanguage` to the **UI language**, coupling interface locale to content locale.

---

## G. Cross-cutting notes for planning

1. **Order matters.** B (verification) before everything else — every other fix needs a gate to stay fixed. Then A (lifecycle) and C1/C2/C3 (the three severe security items) in parallel. D, E, F after.
2. **The four open 008 QA walkthroughs (T084–T087) are the acceptance content for FR-020.** Automating them is the bridge between the two specs.
3. **`scripts/real-agent-check.mjs` and `apps/soty-review/scripts/verify-review.mjs` are existing harnesses**, not things to build. FR-020 extends the first; FR-053 extends the second.
4. **The ESLint child-process ban (A10) is the model** for every structural guarantee this spec asks for: prefer a rule that makes the wrong thing impossible over a test that notices it.
5. **Live-probe evidence recorded 2026-08-23** against the running beta stack: hostile-origin preflight → 403; hostile origin on `/health` → 200 with no `Access-Control-Allow-Origin`; legitimate origin → correct echo; **`Host: evil.example.com` → 200** (C5); all `/api/*` correctly gated by `Invalid session token`.
6. **Browser-driven manual testing was attempted and not possible** in this session (the Chrome extension was not connected). Interface findings in D/E/F are from source audit plus the live HTTP surface. The plan should schedule a real browser pass over D1–D6 to confirm observed behaviour matches the reading.

---

## T119 — the Windows suite run has no runner here (2026-08-25)

T119 asks for one full-suite run on Windows, with every failure recorded and
categorised, and T119a/T119b fix what it finds. None of the three could be done
from this machine: it is macOS, and the failures being hunted — path separators,
temp-directory semantics, process spawning, platform tool discovery — are
precisely the ones that do not reproduce anywhere else. Running the suite here
again would produce a green result that says nothing about Windows.

What changed instead is that the run now exists and is mandatory.
`.github/workflows/verify.yml` has a `test-windows` job that runs the **whole**
suite on `windows-latest`, and `.github/workflows/release-windows.yml` no longer
carries the hand-maintained fifteen-file list it used in place of one. So T119's
discovery pass happens on the first push of this branch, in CI, with output
categorised the same way for every failure — and T119a/T119b become work with a
concrete list attached rather than speculation.

The list that was deleted is worth recording as a lesson rather than a diff. It
existed because there was no way to say "this test needs a macOS package
fixture", so someone enumerated the tests that did not. A curated subset reports
green for everything it forgot to include, and it forgets silently on every
rename. The requirements mechanism states the dependency at the test, an
unexplained skip fails the run, and the list's reason for existing is gone.

---

## Disposition of every finding (2026-08-25)

Ninety-one findings were recorded during the audit. This is where each one
stands after the implementation pass, in the only three categories that mean
anything: **resolved** (the behaviour changed and a test holds it), **accepted**
(the behaviour stands, deliberately, with a reason), and **outstanding** (still
true, not yet done).

Rather than restate ninety-one lines, they are grouped by what happened to them
and by the commit that did it. A finding not named here is outstanding.

### Resolved, with a test

| Group                                                                                                                                                                                                                                                                                                    | Findings                     | Where                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| Power budget: unreachable unsupported state, pin ageing on a stopped cycler, render pool fixed at start-up, lever showing a limit not in force                                                                                                                                                           | A1, A6, A7, D9               | `feat(power): make the shared budget one that cannot quietly stop applying` |
| Verification: no single command, no CI on pull requests, hand-maintained Windows test list, two boot paths for the end-to-end harness, unexplained skips                                                                                                                                                 | A17, B6, B10, B11            | `feat(verify): …` (three commits)                                           |
| Interruption honesty: transport failure treated as absence, state moving backwards, animation asserting unverifiable progress, re-pair destroying the page, un-closable dialog, toast timers outliving their page                                                                                        | D1, D2, D3, D5, D6, D12, A14 | `feat(web): …` (four commits)                                               |
| Local surface: session token in subresource URLs, paths accepted without provenance, error messages carrying file paths, state files readable by other accounts, unbounded request rate, a query language escaped by hand, model hash overridable beside its URL, support directory override unvalidated | C3, C4, C19, C21             | `fix(agent): …`, `feat(agent): …` (five commits)                            |
| Browser origin: no content policy on the origin storing the local app's token, boot recovery blocked by its own policy, single-language recovery screen                                                                                                                                                  | FR-025, FR-057               | `feat(web): give the browser origin a content policy it can survive`        |
| Performance: everything downloaded before anything appears, rows rebuilt on every tick, a decoration in the entry bundle, a filter repainting on every pointer move, unbounded lists, broadcast per encoder tick                                                                                         | E1–E8                        | `perf(web): …`, `perf: …` (four commits)                                    |
| Surface consistency: nine tokens resolving to nothing, focus ring below contrast, stacking by escalation, text that ignored the reader's size, Ukrainian plurals, live regions shouting, a radio group without arrow keys, a document declaring the wrong language                                       | F1–F14                       | `fix(a11y): …`, `fix(i18n): …`, `refactor(web): …` (six commits)            |
| Field reports: a queue busy while holding nothing, a compression that doubled a file, a warning arriving after the work                                                                                                                                                                                  | —                            | `fix(queue): …`, `fix(compress): …`                                         |

### Accepted, deliberately

| Finding                                               | Why it stands                                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing credentials are external                      | The chain is scripted and tested; only the final substitution needs a certificate this repository cannot hold. Recorded in Complexity Tracking at plan time and unchanged.                     |
| Media-action jobs get a real stop but not persistence | Adding a store to satisfy the interrupted-state requirement would be new capability, which this feature does not add. The honest downgrade was chosen at plan time.                            |
| Path ledger enforces nothing yet                      | Observe mode counts what it would refuse and reports the number through diagnostics. Turning a new authorisation check on before that number is known is how a security fix becomes an outage. |
| Google sign-in button is white in both themes         | Brand guidelines require it. A theme checker that flagged it would be one people learn to route around.                                                                                        |
| Two translation keys kept despite reading as unused   | `agentVersion` and `help` are also ordinary identifiers, so no scan can separate a translation use from a coincidence. A dead string costs a line; a deleted live one costs a blank label.     |

### Outstanding

| Finding                                                                            | Blocked on                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows suite has never been run                                                   | No Windows machine here. The `test-windows` job now runs the whole suite on every pull request, so the first run happens in CI rather than never.                                   |
| macOS and Windows quickstart passes                                                | Both need a person at the machine; the Windows one also needs the orphaned-suspended-process check, which cannot be staged remotely.                                                |
| Twenty-six test files excluded from type-checking                                  | Mechanical, and resistant to scripting: the same fixture shape varies enough between files that a regular expression produces wrong fixtures, which pass. By hand, in a later pass. |
| Real-sleep test sites, benchmark wall-clock assertions, temp-directory duplication | Test-suite hygiene; none of it changes what ships.                                                                                                                                  |
