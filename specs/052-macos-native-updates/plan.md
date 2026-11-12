# Implementation Plan: macOS native updates

**Git branch:** `feature/macos-trusted-updates` | **Feature selector:** `052-macos-native-updates` | **Date:** 2026-11-12 | **Spec:** [spec.md](spec.md)

## Summary

Explicit-consent A→B із hosted/local web та меню macOS. Native host owns candidate/consent/installation; agent owns reversible global workload barrier. Soty predownload не озброює installer. Sparkle 2.10.1 запускається лише після durable consent та idle+flush, з bounded повторним download і cryptographic binding до чинного signed manifest. Native activation і UI delivery — різні докази. Apple trust приймається за 048, production не активується цією розробкою.

## Technical Context

**Language:** strict TypeScript/NodeNext, Node 22–24 repository engines; Swift/AppKit/CryptoKit, existing macOS toolchain; ESM release scripts, zsh packaging.

**Dependencies:** чинні Fastify/shared/SSE/React/HeroUI; pinned Sparkle 2.10.1 official tar+hash із [research](research.md), public APIs only, license/third-party notices у bundle.

**Storage:** owner-only, environment/installation-scoped App Support native journal поза `.app`, один writer під lock; окремий agent workload receipt; bounded history/cache. Production DB без змін.

**Testing:** single-worker Vitest state/auth/admission/fault/CLI, native Swift/signing/package tests, real packaged A→B. ARM runtime, Intel static/native evidence розділені за 049, Windows regression.

**Target/project:** macOS ≥13 ARM64/x64, existing desktop host/local service/hosted+local web. Capability потребує confirmed packaged native handshake, не лише OS. Legacy/dev/unprepared beta зберігають fallback.

**Performance/constraints:** 20 samples, p95 idle→ready+visible ≤60 с; download/OS consent/work окремо. Bounded retry/cache/readiness, sleep-aware deadlines, PowerGovernor/platform seams; no kill активної роботи, no downgrade після target first start.

**Scope:** full agent/native release, не mini. Apple setup/trust — 048, next/promote/rollback authority — 051, diagnostics — 031. Native install і release acceptance лишаються execution gates.

## Constitution Check

| Gate | Before research | After design |
| --- | --- | --- |
| I typed boundaries | Pass | Strict manifest/bridge/state validators, closed codes, unknown first |
| II release authority | Pass | Shared signed descriptor у тих самих 051 promoted bytes, no independent stable feed |
| III least privilege | Pass | Owner-only authenticated native bridge, no browser native secret, local Apple keys |
| IV resource/process discipline | Pass | Canonical drain/flush, bounded helpers, platform/power seams, no kill for update timeout |
| V HTTP/module conventions | Pass | Coordinator extends ToolModule list, typed snapshots, 202/409/501 |
| VI composition/state/UI | Pass | Existing API/SSE owner/reconnect, no polling, component inventory/tokens |
| 031 diagnostic coverage | Required | Receipt projection→journal/transport→read-only CLI; explicit missing/unknown |

No exception proposed. Legal/API consent and native fault/runtime proofs are execution prerequisites; design pass is not Apple trust or installation acceptance.

## Project Structure

```text
specs/052-macos-native-updates/
  spec.md, plan.md, research.md, data-model.md, quickstart.md
  contracts/native-updates.md, tasks.md, continuation.md
  original-048-spec.md, original-048-evidence.md, verification-integration.json
packaging/Launcher.swift
packaging/NativeUpdates/           # new Swift bridge/coordinator/driver/receipts
apps/agent/src/update/             # new workload coordinator/routes/receipt
apps/agent/src/platform/platform.ts
apps/agent/src/server/{tools,app,capabilities}.ts
apps/agent/src/team-bridge/        # quiesce/admission/flush integrations
packages/shared/src/{types,release}.ts
apps/web/src/{api,components}/     # existing typed client/update notice
scripts/{analytics,lib/release}/   # receipt diagnosis/signed descriptor/051
scripts/sign-mac-app.sh            # nested helper signing/attestation
tests/                            # central *.test.ts(x), native/package regressions
```

New responsibilities go into focused modules, not large additions to Launcher/index. Native IPC is not a second browser transport. Native journal and agent receipt each own different facts, never one concurrently written JSON.

## Phases

1. **Foundation:** integrate 048 into current base; consented Apple setup, Keychain/notary preflight, real signed Node/fixture and app+DMG trust acceptance. Existing source verification must finish; old beta evidence is not relabelled.
2. **Protocol/durable core:** signed descriptor/strict identity, native single-writer store/lock, authenticated bridge. Keep capability unadvertised until complete.
3. **Reversible workload barrier:** permits before async preflight, scheduler quiesce including recovery/directory intake/waiting attach, tracked queue/settings/stitcher flush, immutable candidate/epoch, safe defer. Tests reproduce races from research.
4. **Installer spike:** exact pinned Sparkle/helper signing both targets; preconsent quit/crash cannot install; strict candidate/dual signature binding; consented replace/relaunch with OS refusal/reboot controls. Private API/default install-on-quit workaround forbidden.
5. **UI/diagnostics:** existing typed API/SSE/reconnect, menu shares attempt, native-ready and UI-visible separate; closed codes/code map/CLI capability inventory and missing/late/reordered signals.
6. **Acceptance:** hosted/local, two successive A→B, busy/queued/background/unknown remote effects, multi-tab/lost reply, corrupt/foreign/revoked/wrong target, faults on every boundary, exact readiness and latency. Windows regression, honest Intel evidence. No production publish in this workflow.

`drained` does not exit and is reversible. Accepted installer handoff is the no-defer boundary, with zero-work hold retained through normal update exit. A Sparkle postpone-relaunch callback is optional bookkeeping, never the sole barrier. After first target start no automatic fallback to older code/data.

Sparkle's privately spawned extraction helpers must not be assumed to inherit PowerGovernor. The installer spike must prove how heavy helper work enters the platform/power budget while its governor owner remains alive, including throttle-scaled deadlines and termination resume. If supported APIs and platform registration cannot prove this, the adapter cannot be enabled: zero concurrent media tasks alone does not prove compliance with a user's CPU ceiling. No independent suspend/resume loop or exemption is authorized by this design.

## Validation status

Integration is saved as a review checkpoint; full verify remains open. Static gates passed; first suite stopped after six of eight shards on jsdom missing `scrollTo`, fixed with a dialog-local spy and top:0 assertion. Six focused DOM tests pass. Developer ID focused run: 47 passed, one notary test skipped. Second suite completed all 8 shards: 10923 assertions passed, 107 skipped, but two more jsdom scrollTo errors in another file kept the gate red. Shared DOM compatibility shim now fixes the missing API; 10 focused tests and test typecheck pass. The new suite was interrupted due severe host resource pressure after 2/8 completed shards (2693 passed, 27 skipped). No full pass is claimed; rerun when headroom is available. Targeted ESLint also passed. See [verification-integration.json](verification-integration.json).

## Complexity Tracking

No constitutional exception. Separate predownload and consented Sparkle download preserve explicit consent using supported APIs. Native/helper fault proofs are mandatory before capability is enabled.
