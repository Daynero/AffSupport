# Research decisions

Read-only repository evidence, 2026-09-08. No production requests/builds or secret reads.

## R1 — Local deterministic worker

**Decision**: .mjs step registry, durable state, macOS user-service worker; explicit resume after reboot.
**Rationale**: package.json/runbook currently require manual coordination; verify-all already demonstrates single bounded verdict. No model necessary for known next steps.
**Alternatives**: more prompt instructions still spend inference; cloud-only runner cannot use local package environment/keys; new orchestration service adds resources.

## R2 — Manifest circularity

**Decision**: candidate/package versus final/deploy validation with governance proposal.
**Evidence**: verify-release.mjs unconditionally compares new version/tool map and verifies signature before --package handling. package.json chains it before packaging.
**Rationale**: cannot supply real future artifact digest. Candidate validates its identity/contracts plus prior trusted stable; final verifies published bytes. Workspace metadata generated from release.ts.
**Alternatives**: placeholder hashes, delayed binary version, skipping gates rejected.

## R3 — Beta evidence

**Decision**: bind record to package source SHA, dirty-at-build, digest and real smoke; invalidate old record at entry.
**Evidence**: verify-beta-package.sh uses current git HEAD without package SHA comparison; early failures leave old verification.json; current checks largely structural.
**Alternatives**: trust record timestamp or current checkout alone does not prove package.

## R4 — Isolated worktree and ownership

**Decision**: own dependencies/dist and stable state outside worktree; explicitly provision ignored profiles and external runtime.
**Evidence**: package-beta-mac.sh defaults runtime source to release/Soty.app; relative env paths assume populated checkout. beta-down kills arbitrary listeners; beta-up mirrors .env.local to supabase/functions/.env.
**Rationale**: record owned process/container identities and snapshot own env changes; don't borrow destructive cleanup.
**Alternatives**: dirty source, shared node_modules, copying every ignored file rejected.

## R5 — Windows identity

**Decision**: source_sha and release_id inputs, pinned checkout in both jobs, correlation run name, serialized publish, expected tag SHA checks.
**Evidence**: workflow has publish input only/default checkout; watcher polls 30s but exits on transient errors without total deadline.
**Alternatives**: latest-run selection and timestamps are ambiguous; manual EXE upload forbidden.

## R6 — Resource admission

**Decision**: single heavy lease plus nested checkpoints; a prebuilt pinned native probe providing all mandatory signals before the first heavy step, whole-machine CPU, stable window; own-process accounting avoids double subtracting RSS. No weaker bootstrap admission or runtime probe compilation.
**Evidence**: lib/gate.mjs serializes phases with SOTY_VERIFY_SERIAL; nested packaging has no load admission. Test machine-probe deliberately independent and must not become runner implementation.
**Alternatives**: fixed sleep, load average alone, independent SIGSTOP controller rejected.

## R7 — Logs and large files

**Decision**: redaction before write, chunk carry for secrets, stream hashing, 30-day cleaned evidence retention.
**Evidence**: sign-release-manifest reads full installer; verify-published-release HEAD tests availability only.
**Alternatives**: redaction after disk write leaks secrets; full logs in model spend tokens; HEAD alone doesn't prove integrity.

## R8 — Backend plan

**Decision**: tracked migration/function allowlist, typed pre/post checks, exact pending-set equality, beta proof, apply before first dependent gate.
**Rationale**: runbook doesn't define arbitrary backend mutations; ambiguous writes require history/evidence reconciliation.
**Alternatives**: generic db push may include unrelated work; model SQL and automatic rollback rejected.

## R9 — Governance

**Decision**: explicit proposed exception, affected gate implementation and real two-SHA integration blocked until a separate ratification resolves two-SHA and candidate gate wording; proposal stored outside active constitution. Rebuild shared before contract consumption remains.
**Evidence**: constitution tag=deployed commit differs from PRODUCTION.md and verify-release ancestry/unchanged-agent-input rule.
**Alternatives**: silently treat current code as overriding constitution rejected.

## R10 — Acceptance baseline

**Decision**: initial 8GiB arm64 target; spec sampling thresholds; conservative class estimates calibrated before activation.
**Rationale**: no real resource or token measurements supplied.
**Alternatives**: unsupported speedup/token claims or silently loosening thresholds rejected.

## Remediation decisions — 2026-09-09

Analysis C1/I1/U1/U2/I2/U3 resolved as explicit design prerequisites and contracts: separate governance prerequisite; shared validated target binding; supervised durable agent bridge; authenticated local lease protocol; preinstalled pinned probe with full signals; migration receipts with authoritative history/postcondition reconciliation. These are designs to implement, not evidence of ratification, installation or successful releases. See contracts/targets.md, contracts/handoff.md, contracts/resources.md and contracts/execution.md.

## Follow-up — 2026-09-09

Constitution 2.0.0 amendment is now prepared under owner authorization, resolving the normative wording in the working tree; repository review/merge remains unclaimed. I3 resolved with explicit fixture versus real integration checkpoints: T018/T029 use injected interfaces, T061 after T032/T035/T051 checks real installed dependencies. No production bypass introduced.
