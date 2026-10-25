# Feature Specification: Web mini release — MVP and additive DB phase

**Created**: 2026-10-25. **Status**: web-only MVP implemented; additive DB phase implemented pending recorded validation/acceptance; native beta/production acceptance pending prerequisites.

**Scope decision**: owner explicitly selected a 3–4 hour implementation slice after the original 82-task estimate. This file supersedes the broad first-release scope. [Original specification](spec-full.md), [plan](plan-full.md), [tasks](tasks-full.md) and their independent reviews remain future design references, not requirements silently marked complete.

## User Scenarios & Testing

### Story 1 — Ship a web fix without rebuilding applications (P1)

An operator checks a clean committed web candidate, verifies it against the unchanged packaged beta, then publishes the exact verified production web bytes. Existing supported installations keep the same signed update channel and installers.

Acceptance: web UI/static changes can pass; agent/shared/config/dependency/function/unknown changes refuse before builds or writes. DB changes require the explicit additive DB phase below. Production packaging and default beta promotion retain their existing exact-SHA rules. New web proof names the exact candidate, unchanged package bytes, configuration, signed live channel, bundle digests and completed real beta UI/runtime checks.

### Story 2 — Recover web bytes safely (P1)

Explicit rollback selects an archived bundle, checks flat/legacy binding identity, immutable bytes and exact equality with the current signed update channel, then records the new deployed state. Failure never triggers automatic rollback or edits the channel.

### Story 3 — Keep the host usable and explain outcomes (P1)

One writer, one heavy command, nice 15, one test worker, bounded heap/native thread pools and resource reads before each boundary. Missing prerequisites or low headroom stop new work with a reason. An agent reads the report without a dashboard; upload success is distinct from verified serving.

## Requirements

- **FR-001**: Reuse existing deploy/final/published/environment/team gates. Do not introduce a new full-runner schema/registry or bypass full packaging beta rules.
- **FR-002**: Keep agent/shared/packaging/runtime/config/lockfiles/web build dependencies immutable against the released agent tag. Permit only web source/static, documentation/tests, explicitly reviewed MVP tooling and DB migration files admitted through FR-009–FR-014; root package changes only add canonical operator commands. Require source ancestry, clean current HEAD and repeated unchanged-input checks. Unknown/mixed changes refuse.
- **FR-003**: Require a historical clean package-provenance payload digest from packaging, matched by full beta verification and a fresh package hash/code signature/source check. Legacy metadata-only records cannot authorize reuse. Initial beta preparation may be a prerequisite; the web-only command never packages agents.
- **FR-004**: Build beta and production configurations once each as needed. A fresh beta browser must authenticate against real local Supabase, pair with the unchanged packaged agent, preserve enforced entitlement and display an actually completed operation. Static routing only substitutes exact candidate assets; API/auth traffic remains real. No fake auth.
- **FR-005**: Freeze proof for exact source, agent inputs, package, binding, effective public configuration, beta/production bundle and unchanged signed channel. Reuse up to 30 minutes only with exact matches. Tampering refuses rather than silently regenerates proof. Full legacy beta record is never relabelled.
- **FR-006**: Archive owned exact bytes before upload, upload the snapshot, run live smoke and sequential bounded byte readback. Preserve app versions/tags/assets/manifest. Record unknown/partial publication durably across worktrees before provider writes; block all web writers until explicit read-only reconciliation proves process quiescence and exact live archived bytes. Missing evidence remains blocked; no automatic retry/rollback.
- **FR-007**: Recovery requires exact current signed channel, correct target and immutable archive; successful recovery advances history. Web rollback never reverses DB changes; functions remain outside this command.
- **FR-008**: Serialize web publication/recovery, bound resource use and logs, refuse insufficient measured memory/disk/CPU headroom, never terminate unrelated work. This MVP uses the owner's existing trusted local release model; dedicated OS/PF/proxy isolation is deferred.

### Additive DB mini phase — owner-approved extension

An operator may ship an agent-compatible web feature with narrowly additive DB changes without rebuilding installers or changing agent versions. The original web-only implementation evidence does not establish acceptance of this extension.

- **FR-009**: Admit only new pending migration files adding nullable builtin columns with no default or constraints, or plain nonunique btree indexes over safe builtin scalar columns of ordinary, nonpartitioned `public` tables. Reject unknown SQL, data writes, drops/renames/type changes, new tables/functions, RLS, expressions/predicates, custom types/opclasses/collations and unvetted relevant event hooks. Existing data and old agent behavior must remain compatible. Require PostgreSQL 17 or newer for server-enforced whole-transaction deadlines.
- **FR-010**: `release:web --plan-db` creates a read-only target-bound draft from exact committed Git migration bytes and the live migration-history/catalog baseline. Use only dedicated `SOTY_MINI_DATABASE_URL`, never analytics credentials. No credential enters a plan, proof or report. Existing history must be an exact supported prefix; unsupported ledger write effects and any ambiguity block.
- **FR-011**: Rehearse with pinned Supabase CLI 2.117 in an owned disposable local PostgreSQL container, limited to one CPU and 512 MiB. Copy schema/role definitions only, without application rows or role passwords. Prove baseline equality, official CLI migration A versus mini A equality, exact official statement tuples tied to source bytes, and successful next full CLI migration B. No production write is part of rehearsal.
- **FR-012**: Bind exact before/after catalog and history, source, target, canonical tuples and rehearsal evidence into the web proof. Require real local beta at the exact resulting schema and a real browser/packaged-agent journey; missing services or schema evidence blocks. A mock or schema-only replay cannot substitute for browser acceptance.
- **FR-013**: After existing production activation gates and fresh baseline validation, apply all approved DDL and its official migration-ledger tuples in one bounded transaction. Recheck actual pre/post policy and exact snapshots. Deploy only the verified web bytes after confirmed DB commit; never rebuild or version agents.
- **FR-014**: Persist intent/session evidence before mutation. An unknown DB outcome blocks every web/backend writer across worktrees until explicit read-only `release:web --reconcile-db` proves committed or aborted. Never replay uncertain SQL, run down migrations, delete evidence or automatically roll back. A committed DB phase remains additive if later web publication fails; web uncertainty uses the separate existing `--reconcile` path.
- **FR-015**: Until the next full agent release absorbs the DB baseline, later web fixes still require a fresh DB draft/proof even with zero pending migrations, because migration paths differ from the unchanged agent tag. Adopt the exact already-applied state read-only; never execute an empty apply transaction or replay history.

### Analytics & Diagnostic Coverage

Existing typed web analytics/support consume injected independent VITE_WEB_BUILD_ID; a product version is not used to merge mini builds. Public web-release metadata and local JSON report identify source/config/artifacts. Report stages distinguish verifying, verified, publishing, completed, blocked, unknown and published-unverified. Read-only report mode performs no build/deploy. Central analytics does not ingest release steps: coverage inventory says unsupported and points to the local report; no fabricated events/zero counts. Missing beta/browser/serving proof blocks completion, and no traffic does not prove a user fix. Collection excludes content, credentials, provider payloads and raw request headers. Success/failure/tamper/resource/rollback regressions test the producer-to-report boundaries.

DB phase diagnostics include bounded local CLI outcomes, plan/rehearsal identifiers, before/after fingerprints, prepared/applying/committed/aborted/unknown outcomes and reconciliation evidence. Critical feature behavior still needs real beta/browser acceptance, with manual checks recorded when not automated. Central analytics does not observe transaction commit or rehearsal directly; missing evidence remains explicit and blocks readiness.

## Success Criteria

- All eligible control deployments change zero agent versions/tags/installers/signed-channel bytes.
- All protected-input, expired/mismatched proof, changed-channel and concurrent-writer fixtures refuse safely; existing full release contracts stay green.
- Verified upload uses the prearchived digest; stale/mutated live bytes never report completed.
- Beta runtime completion includes real auth/entitlement and visible candidate UI result; unavailable real prerequisites remain explicitly unverified.
- One heavy child at a time, nice 15, one test worker, 1 GiB Node heap (2 GiB for the static/compiler gate with ≥25% memory headroom) and two native pool threads; work stops before new heavy steps below configured headroom.

## Assumptions and deferred scope

Trusted local repository/operator, one release host, existing G0/production authorization and beta fixtures. Production deployment is not authorized by implementation. DB changes outside FR-009, function automation, semantic shared exceptions, new distributed/runner recovery, OS account/PF/TLS proxy, expanded native cohorts and repeated timing campaigns belong to the deferred full scope. Current runtime/beta/native/DB evidence is never invented to close acceptance tasks.
