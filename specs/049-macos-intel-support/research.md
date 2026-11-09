# Research: Intel Mac support

> Current owner policy (2026-11-07): [intel-user-feedback-v1](release-policy.md). Physical/native Intel tests are post-release user feedback, not a publication prerequisite. Earlier hardware-blocking checkpoints below are historical; no unexecuted case is marked passed. ARM native beta, Windows hosted, static Intel seals/signatures and applicable Apple trust remain required.

Date: 2026-11-05. Source: repository inspection; this is design evidence, not a tested package. Read-only research delegation used as prescribed by speckit-plan. No external dependency support is assumed verified.

## R1 — Separate Intel package, existing OS floor

**Decision**: separate `macos-x64` DMG, macOS 13+ initially. Keep ARM default commands and identity intact.
**Evidence**: `packaging/Info.plist` and `packaging/FinderExtension/Info.plist` declare 13.0; launcher/Finder targets in `scripts/package-{mac,dev-mac,beta-mac}.sh` and `build-finder-extension.sh` hardcode ARM. `packages/shared/src/release.ts` already admits `macos-x64` as ReleasePlatform, but required platforms/URLs include only ARM/Windows.
**Rationale**: smallest additive target; one set of JS/domain code.
**Alternatives considered**: universal app doubles native payload/provenance complexity; separate Intel product breaks identity; older OS unsupported by current target contract.

## R2 — Inspect all native payload, not only four tools

**Decision**: target-aware Playwright staging and recursive Mach-O compatibility check; pin approved engines and sources, inspect instruction baseline and dylib/deployment dependencies.
**Evidence**: `scripts/lib/agent-staging.mjs` `stageChromiumHeadlessShell()` derives browser from host `chromium.executablePath()` and copies its tree; runtime manifest lacks architecture. `apps/agent/src/landing-preview/renderer.ts` also has developer fallbacks. Existing package/DMG/dev verifiers assert ARM but do not prove all nested helpers match Intel.
**Rationale**: ARM-host cross-build must not silently ship ARM browser; packaged smoke must force bundled engines, with no host-browser fallback.
**Alternatives considered**: substituting Node/FFmpeg only leaves broken previews; running a binary on ARM under translation does not prove Intel compatibility.
**Implementation prerequisite**: record exact approved input versions, sources, digests, licenses, minimum OS and CPU flags. Intel hardware and portable inputs are not proven available. Missing input or incompatibility blocks acceptance; compatible build must be sourced before claiming macOS 13 support.

## R3 — Runtime backend policy

**Decision**: reuse `currentArch()`/capability seam; test Intel CPU Whisper fast mode while preserving ARM behavior and power=100 defaults.
**Evidence**: `apps/agent/src/whisper/transcriber.ts` fast mode uses CPU-oriented greedy only outside `darwin`; comment bases macOS choice on Apple Silicon. `whisper/tools.ts` models are neutral data with fixed digest/size. `power/graphics.ts` may legitimately return null GPU data.
**Rationale**: OS alone is not evidence of accelerator availability. Do not invent Intel Metal performance or require a GPU metric for readiness.
**Alternatives considered**: duplicate transcriber or scatter `process.arch` violates repository platform boundary. No translator payload: feature 046 removed that tool.

## R4 — Selection and historical channel compatibility

**Decision**: explicit Mac architecture controls, authoritative connected runtime identity, fail-closed Intel availability; preserve historical verification separately from new required three-target release.
**Evidence**: `apps/web/src/release-manifest.ts` DownloadPlatform excludes Intel and mac fallback always selects ARM. `scripts/lib/release/intent.mjs`, `packages/shared/src/release-runner.ts` admit ARM/Windows only; `step-adapter.mjs` has fixed ARM DMG path and two-artifact signing loop. `release-meta.mjs` exposes ARM as generic artifact.
**Rationale**: type-union support alone is insufficient. Requiring Intel in the old stable manifest would prevent preparing the first Intel release.
**Alternatives considered**: user-agent-only selection misidentifies hosts; making Intel permanently optional leaves future releases incomplete.

## R5 — Target-bound beta evidence, preserve mini restrictions

**Decision**: per-target package seals and physical runtime proofs aggregated at promotion; update every proof consumer including mini without granting shared/agent mini exceptions.
**Evidence**: existing seams in `scripts/beta-package-provenance.mjs`, `verify-beta-runtime.mjs`, `verify-beta-promotion.mjs`, `scripts/lib/release/`, `scripts/lib/web-only-runtime.mjs` are the integration points. Existing source must be inventoried before edits; no claim that present schemas already support multiple mac targets.
**Rationale**: one ARM beta run cannot certify Intel; immutable packages and exact source identity remain mandatory.
**Alternatives considered**: metadata-only Intel flag or copied proof does not demonstrate execution. Intel-hosted release-controller/resource-probe support is outside scope: `scripts/package-release-runner.mjs` pins ARM probe, which can remain on ARM packaging host.

## R6 — Reuse trust and diagnostics

**Decision**: feature 048 owns signing/notarization/native updater; 049 adds architecture binding and retains installer flow until capability exists. Extend read-only CLI and native identity independently of browser.
**Evidence**: 048 is a draft specification, not proof of implementation. `apps/web/src/analytics/service.ts` currently reports `architecture` from browser, separately from `agent_platform`; treating it as runtime CPU is incorrect. `scripts/analytics/coverage-registry.ts`/`code-map.ts` and typed events are canonical diagnostic seams.
**Rationale**: don't promise an automatic update that is not built or infer historical Intel usage from browser evidence.
**Alternatives considered**: a new updater/analytics service duplicates ownership and loses correlation/guards.

## Open execution dependencies

Intel reference hardware at minimum/newer OS, compatible pinned Chromium and engines, exact CPU baseline and trust readiness remain to be measured during implementation. These are explicit acceptance prerequisites, not unresolved product choices or completed research experiments. All scope decisions are resolved; no release-ready claim is made.

## R7 — Platform-specific execution evidence

**Decision**: aggregate two macOS packaged-beta proofs plus existing Windows hosted validation/installer execution evidence; do not build a Windows beta environment.
**Evidence**: `package.json` routes `beta:package` and `beta:verify` to macOS shell scripts; `scripts/verify-beta-runtime.mjs` launches `release/beta/Soty Beta.app` via `/usr/bin/open`. Windows is already built/validated by `.github/workflows/release-windows.yml`.
**Rationale**: a three-platform release needs three appropriate proofs, not three copies of a macOS-only record. Preserve canonical exact-SHA beta gate and Windows release gates.
**Alternatives considered**: new Windows beta environment expands scope unnecessarily; labelling macOS proof as Windows is invalid.

## R8 — Diagnostic ingestion is a database RPC

**Decision**: update both client sanitizers/guard contract and database guard/RPC via a forward-only migration when introducing safe keys; new columns are optional, server acceptance is not.
**Evidence**: `apps/web/src/analytics/service.ts` calls `ingest_analytics_events`; `events.ts` and `guard-contract.ts` mirror `public.analytics_properties_are_safe_v2`. Current foundation is in `supabase/migrations/20261117100000_analytics_guard_contract.sql` and `20261117110000_analytics_envelope_v3.sql` with later forward extensions. It is not an analytics Edge Function.
**Rationale**: a client-only new property can be dropped or rejected by the database guard.
**Alternatives considered**: editing an old migration or an unrelated Edge Function fails the real producer-to-storage contract.
