# Implementation Plan: Масові запуски
**Branch**: `053-bulk-launches` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md)

## Summary
Polish the existing launch aggregate and add durable batch acceptance over saved drafts. Reuse authoritative generation, lease/recovery, source/body caches and diagnostic paths. No second media executor, no production changes. Load the batch module only after Generate; complete lazy descendants remain included in the measured download budget. Exact base/feature bundle evidence and bounded allocations are recorded in reviews/performance.md.

## Technical Context
TypeScript strict ESM; React/HeroUI/token utilities; Supabase PostgreSQL RPC/Realtime; native Fastify/FFmpeg/PowerGovernor. Vitest single worker, isolated PostgreSQL gate, browser fixture acceptance. Up to 100 explicitly selected saved launches; atomic command acceptance and existing bounded hosted/native execution. Server/native ownership remains authoritative. Durable batch identity/membership in protected storage; UI only observes receipts; no content in diagnostics. Existing dependencies suffice.

## Constitution Check
I: validate projection fields at shared parser. II: release identity untouched. III: existing ACL/CAS/idempotent RPCs, no cache shortcut around authorization. IV: managed media processes, cancellation-aware sharing and temporary workspace cleanup. V: reuse generation endpoints and closed error codes. VI: inventory/tokens, bounded components, existing Realtime invalidation, no new recurring polling. All gates pass before and after design; no exceptions.

## Project Structure
- `apps/web/src/team/launches/`: presentation classifier, selection/clipboard hook, batch coordinator, progressive results; retain LaunchSession generation seam.
- `packages/shared/src/team/launches.ts` and `launches/persistence.ts`: bounded list/detail projection.
- `supabase/migrations/`: forward-only launch chronology/progress/reserved-name projection.
- `apps/agent/src/stitcher/body-cache.ts`, `pipeline.ts`: pinned preparation and immutable consumer files and cancellation.
- `apps/agent/src/team-bridge/restitch.ts`: content inspection sharing.
- `scripts/analytics/coverage-registry.ts`, existing inspect evidence: honest batch/preview coverage.
- `tests/`: behavioral, contract, cache, diagnostic and UI regression; local browser fixture.

## Execution
1. Lock contracts, snapshots and diagnostic semantics; test before stateful changes.
2. US1 list status/chronology, shortcuts and copy feedback.
3. US3 result preview and reserved-name projection, persistent copy affordance.
4. US4 cache ownership/wait cancellation/inspection dedup; benchmark cold/warm scenarios.
5. US2 durable grouped command, independent per-item acceptance/refusal, recovery and cancellation fencing.
6. Two analysis/remediation passes, focused regression, visual acceptance and full verify. Tasks remain unchecked until evidenced.

## Validation and release isolation
Worktree `/Users/daynero/RiderProjects/AffSupport-053`, based on `2d616995` (latest local release source, including launch fixes absent from main), branch `053-bulk-launches`. Do not switch original checkout, alter beta, run packaging/deployment, or touch running apps. Heavy commands nice 15, one at a time, one test worker. A release-only gate requiring unavailable infrastructure is reported explicitly and never bypassed.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: Preparation stays pinned until an immutable hardlink (or exclusive copy across volumes) is materialized in the consumer workspace. The consumer owns that file through join/verification; eviction can then remove the cache entry safely. Retry unlinks a prior workspace entry without overwriting a shared inode.
A3 (owner durability revision): Uncertain admission reconciles the durable batch key and fixed child keys through protected readback; no fresh request identity or generation is created. Original selected versions remain immutable. Legacy config normalization occurs only inside the selected-version CAS acceptance transaction; any concurrent edit refuses that member.

## Owner-requested durability extension (supersedes session-local design)
Trusted Edge prepares shared-validated config/source/default/video plans from an actor-authorized batch context. One service-only acceptance transaction records immutable batch key/membership and invokes existing generation acceptance functions in per-item subtransactions. Normalize legacy catalog defaults under exact selected-version CAS. No browser-provided preview/plan is trusted. Existing hosted catalog worker is the execution owner, with scheduled recovery if immediate wake fails; noncatalog deterministic publication uses the existing source-authorized path. Protected list/read-by-key restores batches after reload, and cancellation delegates to current generation fences. No second generation state machine: child state/progress is projected from canonical generations.

Native background claims gain bounded fair pacing and safe same-installation old-boot adoption only after two-minute silence and all children quiescent (queued without consumed execution/upload authority, or registered). Unknown upload blocks only its own set. Existing worker retry budget/Retry-After remains durable, with a scheduled next probe after exhaustion.

The existing workspace recovery-status owner automatically enrolls eligible missing registrations, including old user-off settings. Native coalesces same actor/team/installation setup across tabs; same-ticket cloud delegation and native confirm are idempotent. Actor/session/entitlement/membership are rechecked across awaits. Existing security retirement is never overridden. Remove Settings opt-in and manual normal-flow Check status; honest offline/setup/update errors remain actionable at the actual connection surface.

UI follow-up: explicit copy/paste counts, offer/social/RK/status captions, reserved card geometry and real progress/settings screenshots. Attempt clock uses earliest confirmed same-attempt anchor and optional local continuity, never a request-stage toggle as a new attempt. Diagnostic acceptance spans submission→durable acceptance/refusal→generation→delivery/cancel/recovery; native setup has correlated stages without secrets. Inspect/audit inventory must explain missing signals explicitly.

Parallel implementation is permitted for disjoint tasks: backend batch/storage/native-set SQL, background enrollment/web owner/native worker, and root UI/clock/diagnostics. Shared files are coordinated before edits. Heavy tests remain serialized. Two artifact analysis/remediation passes precede implementation; two code review/fix passes precede canonical verification.

## Desktop settings refinement
One creative field uses existing authorized thumbnail session and MaterialPreview, with existing DropdownMenu source choices and upload seam. Native file drop enters the same upload; duplicate drop, disabled/unmount/team/method/material changes fence late selection. Compact shelves replace large section headings/nested cards. Variations and the R2 switch stay visible. Duration uses the existing slider in an initially collapsed inline disclosure; its selected time/range is always visible in the heading. Publication scheduling stays in the advanced disclosure. Invalid publication expands both outer and inner controls. Existing default-all field helper behavior stays unchanged for other hosts. Notes drop arbitrary palette/tints, with success color reserved for copy confirmation. These are disjoint parallel T048/T049 tasks; root owns catalog rename investigation and integration.

Canonical catalog rename requires a separate protected impact/read contract: current display/provider name differs from immutable name already encoded in a generated link. Existing rename operation authority is reused; historical alias search and original-name annotations must remain actor/team authorized. T050 resolves exact schema/API seams before T051/T052, and no completion is claimed before real contract and race tests.

### Canonical rename implementation split
T050 research/contracts completed before T051/T052. Backend owns explicit material rename admission, conditional provider reconciliation, aliases/search and SQL/Edge tests. Frontend owns typed projections/API and shared rename control in result and manager. These may proceed in parallel after agreeing contracts; root owns integration/diagnostic evidence. Two analysis passes: (1) found result-only override and broad rename guard conflicts, fixed via canonical projection/narrow authority; (2) found ambiguous provider writes and all-history search gaps, requires conditional replay-safe reconciliation and untruncated alias search.

Pending batch admission is a durable child state, resolved through bounded existing recovery rather than withholding healthy siblings. Global uncommitted outages still replay the identical command; scoped transient failures retain independent backoff/lease records.

## Owner follow-up: single budget and actual SUB summary
Persist budgetMode=single in shared launch config/draft parsers. Extend the existing budget calculation seam with an explicit mode; single uses maxBudget for every row, forbids manual arrays/minBudget, and preserves ordinal/ad-range naming. Existing profiles replace all optional fields, so a saved single mode clears old bounds on apply. UI mode transitions remove irrelevant bounds and use existing shared controls; one field is labeled per-campaign. A forward-only replacement of the existing profile validator admits single without relaxing auto/manual or source/ACL checks. No new worker/API or telemetry payload. Existing LAUNCH_BUDGET_INVALID and correlated acceptance/delivery evidence cover failures/outcomes. Test persistence, preview, UI transitions, profile SQL and batch planning; verify actual desktop layout and bundle costs. SUB summary reuses launchSubPreview and shared Accordion aside; contain long values without changing layout.
