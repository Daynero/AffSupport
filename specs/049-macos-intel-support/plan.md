# Implementation Plan: Soty для Intel Mac

**Branch**: `049-macos-intel-support`, isolated worktree `AffSupport-049-intel` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)
**Input**: `/specs/049-macos-intel-support/spec.md`

## Summary

Додати окремий `macos-x64` артефакт від target-aware dev/beta packaging до download/update selection, триплатформного release runner та діагностики. Не створювати другий застосунок або updater. Реальне Intel acceptance та trust gates 048 — умови публічного запуску.

## Technical Context

**Language/Version**: чинні TypeScript strict/ESM NodeNext, Node/npm workspaces; Swift і zsh для macOS, mjs для release/contracts.
**Primary Dependencies**: bundled Node, FFmpeg/FFprobe + sources/licenses, whisper-cli/VAD/model, Playwright Chromium headless shell, AppKit/FinderSync; версії за repository lock та approved inputs.
**Storage**: existing Application Support/settings/model caches; local sealed package/proof/journal artifacts; existing bounded diagnostic storage. Нового product database не потрібно. Для нових safe props потрібне forward-only оновлення SQL guard; нові колонки лише за необхідності.
**Testing**: Vitest central `tests/`, real packaged beta on Intel та ARM, Windows controls, isolated ingestion/query fixtures.
**Target Platform**: macOS 13+ x86_64 та regression arm64; Windows x64 без зміни функцій.
**Project Type**: desktop agent + hosted/local web + release tooling.
**Performance Goals**: збереження чинних tool deadlines із governor scaling; виміряти startup та fixture runtimes на reference Intel. Не обіцяти ARM throughput на Intel; timeout/unsupported CPU є failure з причиною.
**Constraints**: один heavy child за раз, nice 15, один test worker; no production mutations; non-secret proofs; no raw OS checks outside platform seam.
**Scale/Scope**: одна нова архітектура; 3 stories, 13 FR, 5 SC; shared identity без protocol bump лише через architecture.

## Constitution Check

До research і після design: PASS у дизайні; runtime acceptance ще не виконано.

| Principle                | Design evidence                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| I — typed boundaries     | Closed target mapping, parse unknown input, validators і tests перед integration; no unvalidated casts                                         |
| II — release origin      | Platform/artifact definitions у `packages/shared/src/release.ts`; fresh shared build перед consumers; previous channel перевіряється історично |
| III — least privilege    | Existing origins/session/entitlement; beta real auth; no secrets/production analytics writes; 048 owns trust                                   |
| IV — processes/resources | Platform seam + managed spawns, governor timeout/cancel rules; release admission без обходу                                                    |
| V — HTTP conventions     | Reuse health/capabilities/diagnostics; stable closed codes, no new response envelope                                                           |
| VI — UI/state            | Existing UI inventory, tokens/i18n; single SSE reconnect path; no recurring polling                                                            |

Нових конституційних винятків немає. Вимога конституції перевіряти обидві платформи зберігається і поширюється на третю, жодна чинна не стає optional.

## Project Structure

### Documentation (this feature)

`specs/049-macos-intel-support/`: spec.md, plan.md, research.md, data-model.md, contracts/platform-artifacts.md, contracts/diagnostics.md, quickstart.md, tasks.md, checklists/requirements.md, analysis.md.

### Source Code (repository root)

- `packages/shared/src/release.ts`, `release-runner.ts`, `types.ts`: canonical targets, runtime/diagnostic contracts.
- `packaging/Launcher.swift`, `packaging/FinderExtension/`, `packaging/Info.plist`: target-built native payload, shared identity.
- `scripts/package-{mac,beta-mac,dev-mac,dmg,dev-dmg}.sh`, `build-finder-extension.sh`, `verify-{package,dmg,beta-package,dev-package}.sh`: target-aware packaging/validation.
- `scripts/lib/agent-staging.mjs`, `scripts/stage-agent-runtime.mjs`: target-aware browser and dependency payload.
- `scripts/release-meta.mjs`, `dev-release-meta.mjs`, `lib/release/`, `verify-release.mjs`, `sign-release-manifest.mjs`, `verify-published-release.mjs`: metadata, runner and final artifact validation.
- `scripts/beta-package-provenance.mjs`, `verify-beta-runtime.mjs`, `verify-beta-promotion.mjs`, `lib/web-only-runtime.mjs`: per-target seals/proofs and mini invariants.
- `apps/agent/src/platform/platform.ts`, `server/app.ts`, `server/capabilities.ts`, `whisper/transcriber.ts`: runtime identity/readiness and Intel-safe engine policy.
- `apps/web/src/release-manifest.ts`, `analytics/`, `locales/`, existing download/update components found by caller inventory: choice and diagnosis.
- `scripts/analytics/`, `supabase/migrations/`, `supabase/tests/database/`, `tests/`: end-to-end diagnostic path, contract/negative tests.

**Structure Decision**: extend existing seams; one small canonical packaging target helper in `scripts/lib/macos-target.mjs` (new), not separate Intel scripts copied from ARM.

## Phase 0 — Research

[research.md](research.md) records repository evidence and decisions. Inventory is mandatory before changing scripts: recursively inspect Mach-O payload, deployment minima, dylib resolution, CPU instruction baseline, browser dependencies and every artifact consumer. Approved binary availability is an implementation prerequisite verified with actual inputs, not a claim that local ARM inputs can cross-build Intel. Record versions/digests/sources/license mapping, reference CPU/OS and real execution. Missing suitable input blocks packaging.

## Phase 1 — Design

1. Canonical mapping: `macos-x64` ↔ Node `x64` ↔ Mach-O `x86_64` ↔ Swift `x86_64-apple-macos13.0`; arm64 unchanged. CLI accepts `--arch=arm64|x64` through npm `--`; invalid target fails before clean/build. No-arg mac packaging preserves existing arm64 default until documented deliberate change. Shared owns public artifact names/URLs; helper owns toolchain spelling only.
2. Independent per-target output/staging for all flavors and DMG creation; app identity/port/support directory unchanged within each environment. Host-only tools such as DMG artwork generator are distinguished from shipped target binaries. Never execute target engines during ARM cross-build as proof; static checks for Intel; runtime confirmation is user-led after release. ARM retains native smoke.
3. Stage portable Intel engines and exact target Playwright payload. Recursive Mach-O slice/deployment/dylib scan includes browser helpers and native node dependencies; distinguish architecture-neutral resources. Runtime fast-mode Whisper policy uses actual supported backend/capability through platform seam, preserves ARM and maximum-power behavior. Validate CPU policy through automated source fixtures; real Intel runtime confirmation is first-user feedback.
4. Web has explicit Intel/Apple Silicon controls at every download surface using inventory, tokens and UK/EN strings. Agent identity outranks browser; unknown requires explicit choice. Existing mac helper stays explicitly Apple Silicon, not generic fallback. Signed artifact selection has no Intel fallback prediction. Runtime architecture and physical host under translation remain distinct; no automatic cross-architecture migration.
5. Release runner validates intents/platform sets, builds/adopts each mac package under resource admission, retains both artifact paths and three-platform final checks. Target proof binds source+flavor+arch+sealed bytes+acceptance level; Intel native/hardware outcomes remain unverified. Per-target required proof aggregation replaces single proof reuse. ARM uses native exact-SHA beta evidence; Intel uses its separate exact-SHA static qualification record; Windows retains its own hosted validate/install/use evidence bound to source and final artifact, not a fabricated macOS beta record. The aggregate canonical release gate still requires all existing exact-SHA beta evidence. No Windows beta environment is added. Old previous manifest is trusted against its historical platform set; new candidate requires all three. Historical manifests must not be relabelled or regenerated.
6. Extend full-beta and mini readers together: mini cannot admit shared/agent changes or replace packaged agent, must validate the complete sealed baseline and current signed channel. Architecture support ships as full agent release. For 048, integrate architecture identity/candidate checks only; signing/updater implementation remains there. If absent, manual handoff and explicit blocked trust readiness, no mock native success.
7. Extend existing analytics typed props with native runtime target separately from browser architecture, carrying through `analytics_properties_are_safe_v2`, `ingest_analytics_events`, storage/query. New safe keys require a forward-only SQL guard migration even when no column is added. Prefer existing properties; if schema extension is required, add forward-only migration/types and privacy/RLS tests. CLI `cohorts --cohort-by agent-architecture` is additive; `investigate`, `inspect`, `audit` preserve envelopes and show unknown coverage.

Detailed contracts: [platform-artifacts](contracts/platform-artifacts.md), [diagnostics](contracts/diagnostics.md). [data-model](data-model.md) defines proof state, [quickstart](quickstart.md) defines acceptance.

## Phase 2 — Delivery sequence

Setup/inventory → typed foundation → US1 local Intel package → US2 choice/update selection → US3 release proof/diagnostics → integrated three-platform/trust acceptance. US1 is local MVP only; public Intel support requires all stories and applicable 048 gates. Tests precede risky boundary changes. Implementation is authorised from 2026-11-06; no production version/tag/deployment is authorised.

## Risks and validation boundaries

- Approved runtime payloads remain required. Missing Intel hardware is not a blocker under the owner-ratified user-feedback policy; emulation never becomes physical success.
- Minimum OS or CPU mismatch in bundled Chromium/Whisper can invalidate nominal Swift minimum: actual payload checks gate packaging; first-user feedback validates Intel runtime behavior.
- 048 is draft; do not assume signing or automatic updater already exists. Read its implementation status at integration time.
- Multi-target beta/release proof touches recovery/adoption and mini readback; negative fixtures prevent one target's proof satisfying another.

## Complexity Tracking

No constitution violations requested. Extra complexity is limited to target selection and target-bound proof aggregation required to avoid shipping mixed or untested packages.

## Implementation review — 2026-11-06

The owner requests full implementation, superseding the documentation-only input. Keep the dirty main worktree untouched; `.specify/feature.json` changes belong only to the Intel worktree. Preserve legacy ARM output paths for existing callers while giving x64 disjoint subdirectories. Composite npm commands need an actual argument-forwarding wrapper: npm appends flags only to the final command in an `&&` chain. Validate target before builds, admission, cleanup or listener actions. Missing approved portable inputs block packaging, not independent source implementation. Intel physical/native testing is post-release user feedback. Applicable 048 public trust remains a separate release prerequisite.

The first Intel beta cannot require a previous Intel production app. `scripts/stage-macos-inputs.mjs` therefore stages reviewed local engine/model/source inputs with exact digests into a separate target tree; dev/beta consume it only after digest and native inspection. This breaks the bootstrap dependency without bypassing production/beta auth or release gates. Missing approved engine/browser inputs remains an explicit build prerequisite; physical execution is separate.

## Implementation refinement — 2026-11-07

Intel runtime pins use Node 22.23.4 LTS to preserve the macOS 13.0 floor (the available Node 24 x64 binary requires 13.5). FFmpeg 7.1.1/x264 and Whisper 1.9.1 are built statically with one worker and conservative CPU flags. The actual Chromium revision 1234 x64 archive has macOS 13.0 deployment targets. Version, source and SHA-256 pins are recorded in `packaging/macos/inputs.json`; generated input provenance is immutable per target.

New full-release manifests declare platform set version 2 and require all three platforms. Existing authenticated historical manifests retain their historical set. Both Mac beta proofs bind exact source, public config, agent payload, package metadata and web payload. Intel uses schema-3 static qualification under `intel-user-feedback-v1`; real runtime/hardware observations are post-release feedback. Windows proof binds the hosted run, smoke installer and final published installer. Complete mini-release baselines bind these proofs to the signed channel without rebuilding installers.

Pre-server diagnostic fallback is a bounded local launcher journal (32 records, 32 KiB, closed codes/stages, no paths/content). The native startup UUID is carried separately through health, typed events, SQL guard and CLI diagnosis. `analytics startup <file> --json` reads exported local evidence without database writes. Missing evidence remains insufficient; no client can prove OS refusal before it runs. Apple trust remains mandatory. Physical Intel acceptance is optional post-release evidence and is never inferred from cross-compilation.

Installer request intent uses the closed `installer_target` property. Observed `package_target`, native architecture and startup UUID come only from captured native health context. CLI exposes `requested_installer_targets` separately from installed identity; an installer click never establishes installation, native hardware or result delivery. Guard extension is forward-only in `20261207190000_agent_native_identity_analytics.sql` (single migration, renumbered after 047 by review-claude.md); no table/RPC shape or generated database types change.

Owner-ratified policy and proof levels are defined in [release-policy.md](release-policy.md). Runtime unverified is an explicit accepted Intel evidence level, not a native pass.
