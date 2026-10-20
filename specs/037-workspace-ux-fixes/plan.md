# Implementation Plan: Виправлення робочого простору

**Branch**: `037-workspace-ux-fixes` (feature identifier; current Git branch was not changed) | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/037-workspace-ux-fixes/spec.md`

## Scope update — 2026-10-17

US5–US8 and their finance/account work moved to [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md). The 038 spec supersedes the old read-only combined-view design. Historical story/slice IDs remain stable.

## Summary

Deliver six independently reviewable stories across the task board, explorer, local image embedding, and catalog labels. Accounts/finance US5–US8 are owned by 038. Establish safe state contracts before UI changes for file cleanup, bulk trash and explicit image selection. Reuse current UI and typed diagnostic seams. Ship in slices ordered by data risk and dependencies; each slice is complete only with agent-readable outcome evidence where state changes.

## Technical Context

**Language/Version**: TypeScript (repository strict ESM), SQL/PLpgSQL migrations, React web; Node runtime per workspace configuration.  
**Primary Dependencies**: HeroUI v3/React Aria, Tailwind v4, Supabase/Postgres/Realtime, local Fastify agent, shared contracts.  
**Storage**: Supabase team tables and Google Drive backed materials; local agent settings and operation journal.  
**Testing**: Vitest focused regression/integration tests, Supabase database tests, `npm run verify`, `npm run verify:release`, visual keyboard/zoom checks.  
**Target Platform**: Web workspace on supported desktop/mobile browsers; local image selection on macOS and Windows agent.  
**Project Type**: Monorepo web + shared + agent + database/edge integration.  
**Performance Goals**: For 50 items, each changed state appears within 1 second of the browser receiving its authoritative receipt or Realtime invalidation; no browser main-thread stall. A healthy cleanup worker confirms eligible orphan trash within five minutes after its 30-second grace period.  
**Constraints**: Shared permissions/RLS, privacy-safe analytics, no direct production data mutation during diagnosis, safe provider cleanup, no new UI token literals.  
**Scale/Scope**: Six active user stories, four state-changing journeys needing correlated diagnostics, one local-agent settings extension. Historical US5–US8 are transferred to 038.

## Constitution Check

*GATE before research and after design: PASS, conditional on the implementation gates below.*

| Principle | Plan constraint and verification |
| --- | --- |
| I. Typed contracts | Shared parsers/types for image IDs and operation results; validate external data at boundaries. |
| II. Release/protocol source | No ad hoc version edits; agent settings contract changes must follow existing release/protocol contract gates. |
| III. Least privilege | Copy, cleanup and bulk trash use permission-checked server writes; no raw Drive deletion from browser. |
| IV. Process orchestration | Image choice only changes inputs to existing queue; no new direct child-process spawning. |
| V. HTTP/error conventions | Stable machine codes and idempotent operation results; unknown outcomes are reconciled. |
| VI. Frontend composition | Existing shared UI primitives and token-derived styles; hosted bulk-trash results use the existing `team_operations`/`team_catalog_events` and sole `useTeamRealtime` owner. IndexedDB stores intent/keys only; reconnect rereads the hosted snapshot without new polling. |
| Analytics rule in AGENTS.md | Signals, diagnostic query coverage, blind spots and privacy checks are acceptance gates for each changed journey. |

No constitutional exception is requested. The post-design recheck finds no planned violation; implementation must keep these gates green.

## Project Structure

### Documentation (this feature)

```text
specs/037-workspace-ux-fixes/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/workspace-operations.md
└── tasks.md                    # dependency-ordered implementation tasks
```

### Source Code (repository root)

```text
apps/web/src/team/tasks/             # board, clipboard, attachments
apps/web/src/team/explorer/          # selection, bulk trash, operation journal, menus
apps/web/src/team/catalog/           # catalog heading and material actions
apps/web/src/team/workspace/         # local operations indicator
apps/web/src/components/            # local image embedding and shared UI
apps/agent/src/queue/               # explicit image choice and frozen job
packages/shared/src/team/           # team contracts and diagnostics
packages/shared/src/types.ts         # local image settings contract
supabase/migrations/                # safe cleanup, operation receipts
supabase/functions/                 # Drive-backed cleanup where required
scripts/analytics/                  # code map, capability coverage, read-only diagnosis
tests/ and supabase/tests/database/  # focused regressions and data integrity
```

**Structure Decision**: Extend existing feature modules. Shared contracts describe cross-boundary values; Supabase owns team data integrity, local agent owns image execution, and web owns display/interaction.

## Delivery slices and dependency order

| Slice | Stories / requirements | Main work | Depends on | Exit evidence |
| --- | --- | --- | --- | --- |
| 0. Baseline and contract audit | All | Map authoritative material references, source provenance, operation journal, current date semantics and existing analytics coverage. Capture failing regressions for reported bugs. | None | Inventory and focused failing tests; no unverified delete path. |
| 1. Board and catalog controls | US1, US10; FR-001–004, 017 | Reflow status/date controls; timezone-aware quick dates; correct clipboard/selection lifecycle and idempotent paste result; rename catalog surface consistently. | 0 | Copy/filter/selection, keyboard and timezone tests; diagnostic result for copy. |
| 2. File safety and progress | US2–4; FR-005–009, SC-003, SC-007 | Expose quick detach; 30-second server Undo grace and 14-second UI action, scheduled/recoverable orphan cleanup with complete reference check; hosted group/item trash receipts, content-free invalidation through existing Realtime owner, per-file progress/partial retry; fix menu placement and local chip activity state. | 0; orphan cleanup after reference inventory | Concurrent-link, late-response Undo, worker-off/restart, two-client reload/reconnect and timed 50-item tests; CLI explains outcomes. |
| 7. Local explicit image | US9; FR-016 | Settings field/parsing/migration, UI single choice, agent validation and queue freeze. | 0 | Cross-platform queue tests and end-to-end selected-image outcome/diagnosis. |
| 8. Integration gate | All; FR-018, AD-001–004 | Coverage registry/code map/CLI proof; permission/privacy and visual checks; beta/package verification where required. | Remaining 037 slices | `npm run verify`, release-form gates for migrations/agent contracts, complete quickstart scenarios. |

Slices 1 and 7 can be built independently after baseline. Slice 2 begins with the reference inventory because cleanup has the highest data-loss impact. Historical slices 3–6 belong to 038 and do not block 037.

## Design decisions and risk controls

- **File cleanup:** Detach and moving an orphan to the space's trash are separate states; trash is not a claim of reclaimed storage quota. The server gives a 30-second Undo grace and the existing toast offers 14 seconds only when at least 20 seconds remain (14 seconds visible plus a six-second request margin). The existing scheduled catalog-updater invocation claims due work at least once per minute and recovers interrupted claims. A missing reference type or uncertain provenance retains the file; it must not be reported as trashed.
- **Partial bulk operations:** Hosted group/item state and existing `team_operations` receipts are authoritative. A new content-free `bulk_trash_changed` catalog marker uses the sole `useTeamRealtime` channel with a bounded urgent reread (the current generic one-second debounce is too slow for SC-003), then rereads after reconnect; IndexedDB holds initiator intent and stable retry keys only. No new recurring client polling or subscription. A durable item identity prevents duplicate work.
- **Local images:** Null explicit selection preserves old random behavior. New jobs freeze selected assets; existing jobs are unaffected.
- **Diagnostics:** Record the last proven stage and delivery, not a click as success. Never collect task/file content, paths, finance amounts, external account IDs or provider payloads.

## Complexity Tracking

No constitution violation requires an exception. The feature remains broad; work is split into the slices above so each can be reviewed and verified independently.
