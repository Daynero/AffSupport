# Native update contract v1 — proposed, not implemented

## Browser → agent

Existing `/api/` origin/session/entitlement policy and typed client wrappers apply. Proposed resource `/api/app-update`: GET snapshot, POST `prepare|accept|defer|cancel|ack-visible`. Final route names live in shared contracts during implementation. Commands contain only intent/attempt/candidate IDs, expected revision and idempotency key; no arbitrary URL/path/executable/manifest/native secret.

202 means durably accepted operation; replay returns same attempt. 400 invalid schema/bounds; 401/403 auth/origin/entitlement; 409 stale revision/active other candidate/wrong stage/unknown state; 501 native capability unsupported; 503 confirmed native host unavailable. Lost reply is uncertain acceptance, not a new attempt or assumed refusal. Return snapshot or `{ error: stableMachineCode }` per existing conventions.

Snapshots include identity/revision/last proven stage/allowed actions/closed code. Existing SSE distributes updates, canonical reconnect/visibility owner rereads snapshots, no added recurring browser polling. `ack-visible` requires matching native-ready attempt/build and is idempotent. Closing web does not cancel native work.

## Agent ↔ native

Platform-owned Unix socket, directory 0700/socket 0600, no symlink substitution, one listener under installation lock. Per-boot secret is inherited only by host's own child, never browser/logs/telemetry/URLs. Bounded framed messages, schema/revision/nonce, installation/boot identity and deadlines; malformed input cannot perform actions.

Native owns candidate/consent/install; agent forwards user commands and supplies workload receipt. Native independently verifies shared P-256 signature over exact canonical manifest payload bytes and derives candidate from verified content. Generated key/build inputs come from shared release metadata; Node's independent URL/digest fields are not authority.

Operations: snapshot, prepare, accept, request barrier, commit, defer/release, progress, reconcile installed identity, target-ready, UI-visible. All bind IDs/revisions. Bridge disconnect proves neither replacement nor process death.

## Workload barrier

One coordinator extends canonical ToolModules. Acquire epoch and close admission atomically with permit registration; starts obtain permit before first await. Pause scheduler claims/ticks/attach without aborting accepted work. Wait canonical busy and outstanding permits, flush queue/settings/stitcher/journal, recheck epoch. Persistence failure blocks handoff. `drained` does not exit. Defer resumes only owning epoch/schedulers. Native commit triggers normal update exit after fresh receipt. Existing legacy `/native/update/drain` remains compatible, not browser install API.

## Sparkle / release binding

Pinned 2.10.1, automatic checks/download/install false. Predownload has no Sparkle session. Only durable accepted attempt + barrier starts custom user driver and single-candidate feed derived from signed descriptor. Strict `shouldProceedWithUpdate` checks build/target/URL/length/EdDSA signature through public metadata; Sparkle archive verification stays enabled. Bounded second download is visible; no private cache injection. Defer cancels precommit session completely, not merely dismisses UI. Normal quit before consent cannot install. Relaunch callback is not readiness.

Heavy helper extraction must have proven ownership and registration in the existing platform/power budget while its governor owner lives; dependency spawning is not a bypass. Throttled deadlines use the canonical scaling, termination resumes held children, and no competing suspender is allowed. Unsupported helper-budget integration blocks capability, even with all media work drained.

Descriptor target/URL/length/SHA/EdDSA signature binds one archive in canonical signed manifest and 051 archived/promoted bytes. Absent descriptor preserves legacy behavior. Do not rewrite current stable assets/version/channel. Updater archive signing key is separate from entitlement key, provisioned explicitly and kept local, never CI/browser source. 048 signing enumerates/attests each nested Mach-O before framework/host seal, with exact profiles/no generic security exception. Full agent release required; mini policy/Windows behavior unchanged.

## Diagnostics acceptance

Project durable receipts into existing bounded privacy-safe journal/analytics transport. Extend read-only `updates`, `inspect`, `investigate`, `journal`, `diagnose`, `audit`, `cohorts`, closed codes/code map and capability inventory. Distinguish fact/hypothesis/insufficient, freshness, missing terminal and unsupported producer. Native-ready without web acknowledgement is native success/UI unconfirmed.

Tests cover double-click/multi-tab/lost reply, wrong installation/old runtime, bad descriptor/signature/target, permit races/background attach/flush failure, ordinary preconsent quit, OS refusal, crash/reboot at each boundary, duplicates/reorder/late/missing uploads. Pre-start Gatekeeper and unavailable local uploads remain explicit blind spots.
