# Quickstart validation guide

Interfaces here are to implement, not currently available production commands. Use only dedicated sandbox cloud/database/repository targets during acceptance.

The acceptance command fails closed if the installed probe, lease service or
registered bridge is absent, and always rejects production targets:

```bash
SOTY_RELEASE_PROBE=/absolute/probe SOTY_RELEASE_PROBE_DIGEST=<sha256> \
SOTY_RELEASE_LEASE_SOCKET=/absolute/lease.sock \
SOTY_RELEASE_BRIDGE_CONFIG=/absolute/registered-bridge.json \
node scripts/release-acceptance.mjs /absolute/intent.json
```

## Prerequisites

Implemented feature, existing Node/npm/tools, approved external portable inputs, local beta fixtures and ignored sandbox keys. Arm64 Mac with8GiB for minimum acceptance; record OS/tool versions. Private intent file from implementation fixture names actual clean source SHA and explicit sandbox targets, no secrets. Governance clarification separately ratified before affected gate implementation and real two-SHA integration. Installed runner must include its pinned prebuilt probe and registered working agent bridge.

## Commands after implementation

```bash
nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify
nice -n 15 env SOTY_VERIFY_SERIAL=1 npm run verify:release
npm run release -- preflight --intent /absolute/path/sandbox-intent.json --json
npm run release -- start --intent /absolute/path/sandbox-intent.json --json
npm run release -- status <run-id> --json
npm run release -- report <run-id> --json
```

Heavy checks one at a time when host ready. start returns accepted, not finished. Close terminal/chat: worker continues. Read report after completion signal; user/agent polling not needed.

## Acceptance

1. Three unique sandbox versions: one start each, zero model coordination, both published digests and two SHA beta proofs. Compare delivered diagnostic bytes against same-scenario manual baseline; unknown tokens null.
2. Fake samples/clock test hysteresis, stale/missing signals, nested lease, sleep. Real8GiB pass records working sets, responsiveness p95 and wait time; no killing user's processes.
3. Crash before/after each effect and snapshot boundary; resume checks no duplicate publication/migration and no rebuilt published version. Include PID reuse, orphan tree, torn journal and interior corruption.
4. Lost dispatch/upload/deploy/migration response: reconcile exact prior success; ambiguity blocks, never latest-run selection.
5. Split-token/multiline-key canaries absent from every output/file/model payload. Wrong target/SHA/signature/digest independently block.
6. Backend allowlist test: extra pending migration blocks; empty plan zero writes; partial nontransactional effect no automatic rollback.
7. Cancel during wait/compiler/DMG/upload; only owned resources affected; known external state retained.
8. Changed inputs invalidate unpublished dependent evidence. Published source repair requires new linked intent.

```bash
npm run release -- cancel <run-id> --json
npm run release -- resume <run-id> --json
```

## Required artifacts

Sanitized per-scenario reports/effect recorder/evidence, machine configuration, maximum heavy concurrency, handoff and actual-model accounting separately. Retain ≥30days; never prune active runs automatically. No claimed token percentage without measurements.

Next phase: speckit-tasks, then speckit-analyze. Planning executes no production commands.

## Added remediation acceptance

- Target binding: exercise real sandbox destinations through all canonical gates; prove production destination never reached, including Windows inputs and web project. Do not rely solely on an intent label.
- IPC: concurrent runs for distinct targets still share one host heavy slot; nested requests and worker death must neither deadlock nor release an uncertain reservation.
- Bootstrap: remove/corrupt probe installation and prove no compilation or heavy child is launched; first admitted child already has all mandatory signals.
- Agent bridge: kill/restart bridge after durable job acceptance and lost response; one repair job survives, worker automatically receives result and revalidates. No open chat.
- Migration provenance: existing version without receipt/baseline blocks; prepared receipt plus history and postconditions reconciles lost response; nontransactional partial effect blocks.

T018/T029 are fixture-only orchestration checkpoints. Real dependency readiness is validated in T061 after T032/T035/T051; only then run T062 full sandbox acceptance. Constitution amendment 2.0.0 has been prepared, but actual review/merge evidence must be recorded before affected gate implementation. No additional owner confirmation is needed to prepare the work.
