# Implementation Plan: Масові запуски
**Branch**: `053-bulk-launches` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md)

## Summary
Polish the existing launch aggregate and add bounded batch coordination over saved drafts. Reuse authoritative generation, lease/recovery, source/body caches and diagnostic paths. No second media executor, no production changes. Load the batch module only after Generate; complete lazy descendants remain included in the measured download budget. Exact base/feature bundle evidence and bounded allocations are recorded in reviews/performance.md.

## Technical Context
TypeScript strict ESM; React/HeroUI/token utilities; Supabase PostgreSQL RPC/Realtime; native Fastify/FFmpeg/PowerGovernor. Vitest single worker, isolated PostgreSQL gate, browser fixture acceptance. Up to 100 loaded selected launches; at most two active admission coordinators. Server/native ownership remains authoritative. State and IDs only in the batch controller; no content in diagnostics. Existing dependencies suffice.

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
5. US2 bounded grouped controller reusing useLaunchGeneration, independent failures and stop/scope fencing.
6. Two analysis/remediation passes, focused regression, visual acceptance and full verify. Tasks remain unchecked until evidenced.

## Validation and release isolation
Worktree `/Users/daynero/RiderProjects/AffSupport-053`, based on `2d616995` (latest local release source, including launch fixes absent from main), branch `053-bulk-launches`. Do not switch original checkout, alter beta, run packaging/deployment, or touch running apps. Heavy commands nice 15, one at a time, one test worker. A release-only gate requiring unavailable infrastructure is reported explicitly and never bypassed.

## Analysis pass 1 resolutions
A1: Parent succeeded plus pending/failed video is not all-ready; list projection retains separate child counts/state.
A2: Preparation stays pinned until an immutable hardlink (or exclusive copy across volumes) is materialized in the consumer workspace. The consumer owns that file through join/verification; eviction can then remove the cache entry safely. Retry unlinks a prior workspace entry without overwriting a shared inode.
A3: Uncertain admission retains original hook and exact request identity; no fresh automatic retry or new batch admits that item. Queued snapshots use exact version CAS.
