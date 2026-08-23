# Implementation Plan: Release Hardening Pass

**Branch**: `009-release-hardening-pass` | **Date**: 2026-08-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-release-hardening-pass/spec.md`

## Summary

Prove that Soty behaves under interleaved, interrupted, real use — on Windows and macOS — and make that proof cheap enough to repeat. Seven prioritised outcomes: truthful run states across start/stop/switch/restart, one honest shared power budget, one-command machine-readable verification, an interface that never lies during a disruption, a hardened local surface and browser origin, measurable performance gains, and one consistent visual surface.

The technical approach that emerged from Phase 0 is consistent across all seven: **prefer a rule that makes the wrong thing impossible over a test that notices it.** The repository already proves this works — a lint rule bans direct process spawning outside one module, so a tool added later inherits the resource governor whether its author knew about it or not. This feature applies the same idea to lifecycles (a transition table keyed on the status union, so a new state is a type error), to coverage (critical-module membership derived by walking the import graph, so a new state module cannot be omitted), to skips (a requirement marker in the test title, so an unexplained skip fails the run), and to translations (a lint rule on the cast that marks a runtime-built key).

Nothing here adds product capability. Where a guarantee cannot be met without behaviour change, the honest downgrade wins: media-action jobs get a real stop but **not** persistence, because adding a store to satisfy the interrupted-state requirement would be new capability.

## Technical Context

**Language/Version**: TypeScript 5.9, `strict: true`, ESM with `NodeNext` module resolution (explicit `.js` import specifiers, including type-only imports). Node 22.23.2 on the maintainer's machine.

**Primary Dependencies**: Fastify 5.6 (local app), React 19.2 + Vite 8.1 (interface), Supabase JS 2.110 (backend), Playwright Core 1.62 (preview rendering, and the browser harness), vitest 3.2 (tests). External binaries: FFmpeg, a transcription engine, a translation engine.

**Storage**: JSON state files under the user's application-support directory (queue, transcription, preview catalog, power limit, session token, entitlement); Supabase Postgres for accounts, analytics and team workspace; no local database.

**Testing**: vitest, all tests centralised in `tests/` as `*.test.ts(x)`, jsdom opted into per file. In-process HTTP tests assemble a real server through dependency injection. One out-of-process end-to-end harness exists and is currently run by nothing.

**Target Platform**: macOS (Developer ID app, DMG) and Windows (Inno Setup installer, .NET tray host); the interface is served from Cloudflare Pages and also served locally by the app itself.

**Project Type**: npm-workspaces monorepo — local HTTP agent + browser SPA + shared contract package + release/packaging scripts + Supabase functions.

**Performance Goals**: fast verification form under 2 min (measured baseline 41 s); release form under 10 min (measured 7–8 min); success output ≤20 lines, failure ≤100; initial download −40% with each of the three largest pieces −30%; time to interactive −30% on a throttled profile; responsive interaction with 200 live-updating queue items.

**Constraints**: stop takes effect within 5 s and consumption returns to ≤2% within 10 s; combined consumption within 10 points of the limit averaged over 60 s; connection loss reported only after 3 s; capability tickets live 5 minutes; equivalence of output is defined by decoded content, not bytes — multi-threaded encoding is not deterministic and the limiter suspends processes.

**Scale/Scope**: ~205 test files / 1403 tests today; 13k-line single stylesheet; 1335 translation keys × 2 languages; 5 run queues; ~40 release and packaging scripts; 57 audit findings plus 7 discovered during planning.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1. Both passes below.*

| Principle | Pre-Phase-0 | Post-Phase-1 |
|---|---|---|
| **I. Type-safe contracts, validated at the boundary** | PASS — the feature exists partly to extend this. | **PASS, strengthened.** The lifecycle tables are exactly the "string-literal state machines so a typo can't silently skip a case" the principle asks for. The path ledger replaces raw untrusted paths with validated grants. One caveat surfaced and is addressed: `tests/` and `scripts/` are type-checked by **nothing** today, so the principle is currently unenforced in a third of the repo — R15 fixes that, and it is the first task in the feature. |
| **II. One source of truth for release and protocol** | PASS | **PASS.** The lifecycle module is deliberately a **sibling** of the release module, not part of it, precisely because the principle requires release identity and contract versions to stay decoupled. Artifact host pinning reads the same constant the download URLs are built from rather than duplicating it. |
| **III. Security and least privilege by construction** | PASS — this is Story 5. | **PASS, materially advanced.** Adds host validation, constant-time comparison, the token out of URLs, a content policy on the origin that stores it, per-route limits, and the path ledger. One item is a **deliberate acceptance**: signing credentials are external and gate only the final substitution — see Complexity Tracking. |
| **IV. Disciplined child-process and resource orchestration** | PASS | **PASS.** No new spawn sites; the lint ban is extended, not weakened. The stub tools used in end-to-end runs go through the same governed seam. Temp-directory cleanup and escalation-on-stop are tightened, not loosened. |
| **V. Consistent HTTP API and error conventions** | PASS | **PASS.** Every new route follows `registerXRoutes` + snapshot-or-`{error}`, with stable machine codes (`HOST_NOT_ALLOWED`, `PATH_NOT_GRANTED`, `TRANSITION_NOT_ALLOWED`, `UPLOAD_BUDGET_EXCEEDED`, `TICKET_INVALID`) and deliberate status codes — `409` for wrong-state, which the principle already names. The multiplexed stream **extends** the event envelope rather than reshaping it, and media-action state rides an existing snapshot for the same reason. |
| **VI. Frontend composition and state discipline** | PASS | **PASS, with one thing checked and rejected.** A hand-rolled store was considered for the re-render problem and **rejected** because the principle mandates the context idiom with a test override, which five tests rely on. `useSyncExternalStore` is a React primitive, not a dependency, and lives inside the provider. No data-fetching library is added. |

**Result: PASS both times. No principle violation requires justification.**

Three things the constitution already sanctions and this feature closes: the named CI gaps ("do not mistake a green default branch for verified"), the silently-passing real-binary tests it calls an anti-pattern to fix, and the missing type-check gate it works around by telling contributors to run a build.

## Project Structure

### Documentation (this feature)

```text
specs/009-release-hardening-pass/
├── spec.md                        # 71 FRs, 23 SCs, 7 prioritised stories
├── findings.md                    # audit evidence, A1–A18 / B / C / D / E / F / G
├── plan.md                        # this file
├── research.md                    # Phase 0 — 25 decisions
├── data-model.md                  # Phase 1 — 10 entity groups
├── quickstart.md                  # Phase 1 — validation guide, per story, per platform
├── contracts/
│   ├── agent-http.md              # local app surface: admission, stream, grants, stop, limits
│   ├── lifecycle-api.md           # shared transition-table contract
│   ├── verification-cli.md        # the one command
│   └── web-origin-headers.md      # content policy and protective headers
├── checklists/requirements.md     # spec quality checklist (passing)
└── tasks.md                       # NOT created by /speckit-plan
```

### Source code (repository root)

Existing monorepo layout. Files this feature adds or substantially changes:

```text
packages/shared/src/
├── lifecycle.ts                   NEW — transition-table mechanism + 7 lifecycles
├── types.ts                       state unions gain interrupted/cancelled; snapshots gain revision
└── index.ts                       barrel re-export

apps/agent/src/
├── server/
│   ├── app.ts                     one admission hook; logger serialisers and redaction
│   ├── sse.ts                     channel hub, heartbeat, stalled-writer drop, subscriber cap
│   ├── stream.ts                  NEW — GET /api/stream
│   ├── tickets.ts                 NEW — subresource capability tickets
│   └── tools.ts                   ToolModule gains lifecycle / cancel / cancelAll
├── files/
│   ├── path-grants.ts             NEW — the ledger
│   ├── picker.ts                  mints grants; command construction made safe by design
│   ├── dropped-source.ts          mints grants; search expression takes a value, not a string
│   └── paths.ts                   derived-output writes are pattern-bound
├── queue/
│   ├── queue.ts                   CompressorActivity replaces five fields; transition()
│   ├── store.ts                   0600 mode; unlink orphaned output at load; finishedAt fix
│   ├── transcription-queue.ts     transition(); per-job cancel
│   └── transcription-store.ts     interrupted, not failed
├── landing/optimizer.ts           phase becomes derived; transition()
├── landing-preview/catalog.ts     render concurrency from the live limit
├── media-actions/{queue,routes}.ts  lifecycle, user-facing cancel, session routes
├── platform/{platform,windows-suspend}.ts  degradation reported to the governor
└── power/governor.ts              live support flag; wall-clock pin ageing

apps/web/src/
├── api/
│   ├── event-stream.ts            NEW — fetch-based reader, header auth
│   ├── useAgentEventStream.ts     grace period, backoff, multiplexed subscribe
│   ├── reconcile-queue.ts         NEW — stable identity so memoisation is not a no-op
│   ├── pairing-token.ts           in-page handshake, per-browser budget, claim election
│   └── client.ts                  one stream URL; tickets; no token in any URL
├── AgentContext.tsx               split contexts; external store with selectors; revision guard
├── App.tsx                        revive in-page degradation; stable callbacks; memoised row
├── ProtectedSoty.tsx              setup screen no longer reacts to transport
├── components/{Modal,ui}.tsx      one dialog implementation; focusable set; keyboard patterns
├── lib/tool-registry.ts           exported route list — the source for the a11y matrix
├── i18n.ts                        plural rules; dead keys removed
├── styles.css                     define the 9 missing properties; create text and stacking scales
└── index.html + public/_headers   policy hashes; localised, theme-aware pre-load

scripts/
├── verify-all.mjs                 NEW — the one command
├── lib/{gate,axe-sweep}.mjs       NEW
├── verify-{styles,i18n,a11y}.mjs  NEW
├── sign-mac-app.sh                NEW — Developer ID, hardened runtime, notarize, staple
├── package-mac.sh                 ad-hoc signing replaced
├── real-agent-check.mjs           shrinks to a shim over the vitest e2e files
└── generate-team-contract-sql.mjs --out flag, so the suite stops mutating the tree

tests/
├── support/
│   ├── machine-probe.ts           NEW — independent observation
│   ├── agent-process.ts           NEW — real out-of-process boot, nine paths redirected
│   ├── interleaving-scenarios.ts  NEW — declarative sequences
│   ├── stub-tools/                NEW — governed, CPU-burning, SIGTERM-ignoring on demand
│   ├── requires.ts                NEW — collection-time probes, named skips
│   ├── fake-agent.ts              NEW — shared interface fake (browser + component tests)
│   └── wait.ts                    NEW — the one polling helper
├── lifecycle-transitions.test.ts  NEW — table × driver enumeration
├── interleaving-e2e.test.ts       NEW — FR-020
├── real-media-e2e.test.ts         NEW — fidelity assertions moved from the script
└── run-state-coverage.test.ts     NEW — derived critical-module membership

tsconfig.check.json                NEW — tests
tsconfig.scripts.json              NEW — scripts
.nvmrc / package.json engines      NEW — kills the Node skew at source
.github/workflows/verify.yml       NEW — pull-request gate on Linux + macOS + Windows
```

**Structure Decision**: the existing workspace layout is kept unchanged. This is a hardening pass, not a restructure. The only structural addition is `tests/support/` as a real shared-fixture directory — today three support files totalling 175 lines serve 205 test files, while a temp-directory helper is copy-pasted into 41 of them and a polling helper is reimplemented six times.

## Execution Order

Derived from the four research passes. One hard prerequisite and three couplings.

**Prerequisite — the type-check gate is first.** The lifecycle tables' compile-time guarantee only fires under a type-check, and today the test tree and scripts are in no tsconfig. Sequencing it anywhere but first makes SC-003 unenforceable.

| Wave | Content | Blocked by |
|---|---|---|
| **0** | Type-check configs and gate · dependency upgrades then the audit gate · constant-time comparison + host validation in one hook · logger redaction · multipart default inversion · the harness's nine redirected paths (A13) | — |
| **1** | Lifecycle module + 7 tables + enumeration test ‖ machine probe + wait helper + stub tools ‖ signing chains with test identities + artifact host pinning ‖ content policy + smoke test | Wave 0 |
| **2** | Permissive → strict transitions · literals collapsed · derived phase · A12 · the independent wins: A7, A6, A2(ii) | Wave 1 |
| **3** | Compressor activity collapse (characterise → shadow → invert) → A5, A2(i), A8 → A1 · ToolModule cancel surface → A3 | Wave 2 |
| **4** | Interface: revive degradation → revision guard → multiplexed stream → in-page re-pair → store with selectors | R7 needed before R9 |
| **5** | End-to-end harness, scenarios, retire the duplicate script · pull-request workflow on both platforms · coverage baseline and derived critical set | Waves 1–3 |
| **6** | Path ledger prerequisites (env validation, file modes) → ledger in observe mode → open-target validation, temp cleanup | Wave 3's restoration semantics |
| **7** | Performance: code splitting, lazy images, virtualised lists, decorative-animation gating · consistency: scales created, checkers, accessibility sweep from report-only to zero | Wave 4 |
| **Parallel, unblocked** | Backend grant tickets (different runtime, zero coupling — can start day one) · verify-before-adopt pairing · command-construction fixes · error-code taxonomy · environment-gated backend origins | — |
| **Credential gate** | Substituting real signing credentials into a chain already proven end to end | External procurement |

**Zero-day task, before any of it**: the reproduction pass in [quickstart.md §0](./quickstart.md). The audit's loudest interface conclusion was never observed in a browser. Reproduce or retract.

## Complexity Tracking

Three deviations from "simplest thing that could work", each deliberate.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Seven lifecycle definitions instead of one merged state set | The state sets differ **semantically**: `interrupted` exists only where jobs persist; `skipped` is a real outcome no encoder has; transcription and landing carry genuine sub-runs. | One merged union forces either lies or permanently unreachable members that FR-019 would then demand tests for — and it reshapes four wire contracts plus every status style and translation key. That is a rewrite, which the spec's Assumptions forbid. |
| A path-grant ledger rather than a prefix allowlist | The compressor writes output **next to the original**, so a read grant naively implies write access to a whole folder; and the queue persists across restarts, so authorisation must survive one without contradicting restoration. | A static allowlist of permitted roots cannot express "this one file, plus a derived name beside it", and a separate grants file would drift from the queue — producing either "queue restored but refuses to run" or a grant outliving its job. |
| Two type-check configurations with different module resolution | The test tree imports three mutually incompatible worlds; no single Node-style configuration spans them. | One unified config was tried and cannot work. This does **not** weaken the repository's explicit-extension rule, which is enforced on *source* by three existing configs that are untouched — a comment block at the head of the new config states this so it cannot be misread later. |

**One accepted external dependency, not a deviation**: publisher verification requires an Apple Developer ID and a Windows code-signing certificate. Procurement is outside this feature. The entire chain is built and proven against test identities first, so the outstanding step is a credential substitution rather than a build — which is why SC-010 is worded conditionally.

**Two new dependencies total**, both justified in [research.md](./research.md): a coverage provider, and promoting a CSS parser already resolved in the lockfile to an explicit root dependency. Two further packages move from a sub-app to the root — already installed, not new.

## Known Risks

| Risk | Where | Mitigation |
|---|---|---|
| Enforcing a **wrong** transition table | Wave 2 | Permissive rollout: record edges without blocking, reconcile against what the running code actually does, then flip to strict. |
| The compressor collapse breaks the estimate handoff | Wave 3 | Characterisation tests first, then a shadow field cross-checked at every broadcast, then inversion. At no point does the code run on an un-cross-checked representation. |
| The path ledger empties a user's queue after an upgrade | Wave 6 | Observe mode for one beta cycle so the false-refusal rate is measured, not hoped. A **positive** suite alongside the adversarial one. **No kill switch** — an environment flag to disable the check would be the first thing an attacker sets. |
| First full suite run on Windows surfaces many real failures | Wave 5 | Expected, and the point. Land the Windows job non-required for one cycle, then flip it. Do not schedule it last. |
| A content-policy mistake is total and invisible to unit tests | Wave 1 | The browser smoke test asserting zero violations is not optional; it is also the permanent regression gate. |
| The aggregator reports green wrongly | Wave 0 | It has its own test: gate ids unique per form, a stubbed failure surfaces its own id, output budgets hold. |
| Fixing interface bugs that were never observed | Wave 4 | The reproduction pass gates the wave. |
