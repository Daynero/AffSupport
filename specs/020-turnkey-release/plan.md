# Implementation Plan: Реліз під ключ на слабкій машині

**Branch**: actual Git branch `main`; feature identifier `020-turnkey-release` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/020-turnkey-release/spec.md`

## Summary

Детермінований локальний CLI runner керує чинним канонічним релізом: durable journal, ресурсний admission перед кожним важким підкроком, відновлення невідомих зовнішніх результатів і перевірка двох SHA. Штатний прохід не потребує моделі чи відкритого чату. ШІ отримує один очищений пакет нестандартного збою.

Спочатку виправляються contract gaps: candidate/final manifest validation, SHA всередині beta package, immutable source Windows workflow. Обгортки над існуючими командами без цих змін недостатньо.

## Technical Context

**Language/Version**: Node.js `>=22.12 <25` згідно package.json; ESM .mjs із JSDoc/checkJs; shared operational types — strict TypeScript NodeNext.

**Primary Dependencies**: чинні npm scripts, git, gh, zsh, macOS packaging tools, Supabase tooling, pinned Wrangler. Node fs/crypto/child_process; невеликий Swift resource probe. Без нового orchestration framework або model SDK.

**Storage**: приватний `release/automation/<run-id>/` поза mutable checkout; append-only journal, atomic snapshots, очищені logs/evidence. Каталоги 0700, файли 0600; ключі залишаються у gitignored config/keys.

**Testing**: central Vitest, fake clock/targets, fault injection; три повні sandbox releases; реальний слабкий Mac.

**Target Platform**: macOS arm64 maintainer host; Windows builds у CI.

**Project Type**: operational CLI та supervised worker, без нового Soty HTTP/UI.

**Performance Goals**: p95 status ≤2s; один heavy slot; 5s sampling/30s stability; summary ≤20 lines/8KiB; error ≤100 lines/16KiB; zero model orchestration calls.

**Constraints**: nice 15; serial nested work; exact-SHA beta; immutable published bytes; no secret persistence; live acceptance.

**Scale/Scope**: один maintainer host, один writer на repository/environment; повний двоплатформний release; тільки allowlisted compatible backend changes. Minimum acceptance target — arm64 Mac з 8GiB RAM; це тестова ціль, не виміряний результат.

## Constitution Check

| Principle               | Before research / after design                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed boundaries        | PASS: validate unknown intent/journal/probe/service data; discriminated results.                                                                                                                                          |
| Single identity         | PASS for design: release.ts source; derived versions generated; shared rebuilt before consumers. Phase-aware gates require proposal below.                                                                                |
| Secrets/least privilege | PASS: no secrets in model/logs/state; analytics remains read-only; target-bound backend allowlist.                                                                                                                        |
| Process discipline      | PASS: argv spawn shell:false; owned process trees, bounded streaming; no second PowerGovernor suspend.                                                                                                                    |
| HTTP/frontend           | Not applicable; no new app surface or changed existing envelopes.                                                                                                                                                         |
| Release governance      | Aligned with constitution 2.0.0 working-tree amendment: preparation/package/final contexts and manifest-only descendant are explicit. Ordinary amendment review/merge remains pending; no merged ratification is claimed. |

### Governance proposal

The separate working-tree constitution amendment with Sync Impact Report now defines:

- Tag/binaries bind release SHA; manifest-only descendant binds web and has its own exact-SHA beta proof.
- Candidate package validation checks candidate metadata/contracts and trusted previous stable. Final new manifest signature/published bytes remain mandatory before deploy.
- Generated workspace versions derive only from release.ts.

Follow-up on 2026-09-09: the maintainer authorized the amendment, now prepared in .specify/memory/constitution.md version 2.0.0. T001's document preparation is complete. G0's ordinary amendment review/merge is still a prerequisite for affected gate implementation and real two-SHA integration; no further conversational approval is needed. Record actual merged commit when it exists. Foundation and pure fixture/resource/recovery work may proceed meanwhile.

## Project Structure

### Documentation (this feature)

```text
specs/020-turnkey-release/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/cli.md
  contracts/execution.md
  contracts/resources.md
  checklists/requirements.md
```

### Source Code (repository root)

```text
scripts/release-runner.mjs
scripts/release-worker.mjs
scripts/lib/release/
  intent.mjs
  state.mjs
  journal.mjs
  ownership.mjs
  steps.mjs
  execute.mjs
  resources.mjs
  probes-macos.mjs
  evidence.mjs
  diagnostics.mjs
  adapters/                 # git, beta, package, github, backend, web
packaging/release/ResourceProbe.swift
packages/shared/src/release-runner.ts
config/release-resource-profiles.json
tests/release-runner-*.test.ts
tests/support/release-runner/
```

**Structure Decision**: extend operational scripts, not running user Agent. Reuse watcher/gate seams; old CLI outputs stay compatible.

## Phase 0 — Research

[research.md](./research.md) resolves choices from repository evidence. No historical token or resource savings claimed. Calibration is acceptance work.

## Phase 1 — Integration sequence

### A. Repair contracts

1. Separate candidate/package and final/deploy checks in verify-release.mjs; default stays final. Candidate validates prior signed stable separately, never fake future hashes. All applicable contract checks preserved.
2. Add deterministic version projection from release.ts to workspace/lock metadata and notes; allowlist generated changes before freeze. No protocol-version invention.
3. Pass explicit candidate context to verify:release prepublication contract gate; retain all other gates/coverage. Final validation after signing mandatory.
4. Beta pack records dirty-at-build and source SHA; smoke compares actual package SHA/digest to HEAD, invalidates old record at entry, writes atomically after success. Add real bounded authenticated packaged smoke; current structural checks alone do not prove that journey.
5. Windows inputs source_sha/release_id/mode; both jobs checkout exact SHA. Assert tag SHA before publish, inspect existing assets before costly rebuild, serialize publish without cancel-in-progress.
6. Stream installer hashing in signing and published verification; current signing loads whole file, current published verifier only checks HEAD availability.

### B. Ownership, journal and worktree

CLI starts worker under macOS user service using absolute executable/cwd and explicit env. Accepted ack only after durable start. Closing chat does not stop worker; after OS restart explicit resume reconciles. No auto-start at login required v1.

Create owned branch/worktree from specified source. Own node_modules/dist; no shared mutable workspace symlinks. Resolve external beta runtime/input paths and allowlisted private bindings; never copy all ignored files. Snapshot/restore runner-owned generated env changes. Avoid beta-down against borrowed listeners: track own processes/containers and busy checks.

Remote pushes fast-forward only with refreshed ancestry/tip checks. Use origin/beta for promotion checks; independently verify both remote refs. Local main checkout remains untouched.

### C. Resource-aware nested execution

Registry enumerates heavy substeps inside verify/package, not just outer npm invocations. Outer lease inherited by nested admission wrapper; child checks fresh stable window without reacquiring its own lock. Serial runPhase, single test worker, sequential builds. Standalone commands remain usable without runner.

Preflight performs only light probes. Dependency installation, shared build, probe availability validation and stack startup are resource-gated preparation. The installed runner includes a prebuilt arm64 resource probe with a pinned digest and source provenance. No probe compilation occurs during release or preflight. Probe provisioning is a runner installation prerequisite; absent/invalid probe blocks preflight before any heavy operation. All mandatory signals, including pressure and swap, are required from the first heavy step.

### D. Effects, diagnostics, backend

Adapters expose inspect/execute/reconcile/verify with typed outcomes. Unknown external result reconciles before retry. Exact pending migration set must equal tracked allowlist; target and compatibility checked before first dependent gate. No ad-hoc SQL or arbitrary intent commands.

Chunk-safe secret redaction before disk/model output; raw logs never retained. Unsupported safely unredactable output discarded in favor of typed error. Durable handoff outbox deduplicated by fingerprint; an independently supervised, configured agent bridge consumes it without an open chat. The bridge interface and outage behavior are mandatory in contracts/handoff.md; no LLM implementation or secret injection into model context inside runner. A bridge outage leaves a durable blocked release and automatically retries delivery without duplicate repair jobs.

### E. Acceptance and rollout

| Requirements         | Validation                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| FR-001–012, 037–038  | ordered fake effects + full sandbox pipeline; candidate/final gates; both SHA and beta proofs     |
| FR-013–021, 039      | fake samples/clocks; nested lease; unknown signals; sleep; measured weak Mac                      |
| FR-022–028, 036, 040 | crashes at each effect boundary; PID reuse/orphans; damaged journal; cancel; concurrent start     |
| FR-029–031           | split secret canaries; wrong targets; pending migration equality; zero backend writes when absent |
| FR-032–035           | zero-model pass; capped output; handoff dedupe; measured baseline and nullable tokens             |
| SC-001–008           | three sandbox releases; fault matrix; 8GiB host responsiveness/memory observations                |

Run verify and verify:release under nice 15 / SOTY_VERIFY_SERIAL=1 after implementation. Real cloud/database/package tests use dedicated sandbox targets through contracts/targets.md, including derived origin, artifact URLs, public signing identity, backend and deploy project. Production remains pinned to existing production identities; an intent cannot redirect it. Existing hardcoded commands must use this validated shared target binding before sandbox acceptance. Failed 8GiB acceptance requires working-set/concurrency correction, not silent minimum increase.

## Complexity Tracking

| Proposed exception / mechanism               | Why needed                                      | Simpler alternative rejected                                                                                         |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase-aware/two-SHA governance clarification | Final hashes exist only after build/publication | Fake manifest or gate skip destroys provenance; normative text is prepared; actual amendment review/merge remains G0 |
| Durable journal + worker supervisor          | Survive chat/crash and unknown responses        | Shell chain loses effect identity                                                                                    |
| Nested resource checkpoints                  | Protect host inside verify/package              | nice + outer queue misses internal heavy boundaries                                                                  |

## Integration checkpoints clarified — 2026-09-09

T018 implements preflight against injectable probe/bridge interfaces. US1's T029 checkpoint uses explicit fake implementations and validates the real validation logic, never skips checks. After T032, T035 and T051, T061 runs actual installed-probe, lease-server and functioning-bridge checks; T062 exercises the complete real sandbox pipeline. Thus US1 fixture completion does not depend on later real components, and real preflight never accepts missing dependencies.
