# Implementation Plan: Виправлення робочого простору

**Branch**: `037-workspace-ux-fixes` (feature identifier; current Git branch was not changed) | **Date**: 2026-10-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/037-workspace-ux-fixes/spec.md`

## Scope update — 2026-10-17

US5–US8 and their finance/account work moved to [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md). The 038 spec supersedes the old read-only combined-view design. Historical story/slice IDs remain stable.

## Reconciliation — 2026-10-20

The working tree was audited before changing completion flags. Existing implemented foundations are the inline quick-day layout and right-aligned statuses, shared portalled action menus, quiet settled operation chips, and catalog-manager labels. The audit found that copy reset board state without a durable retry key, detach lacked grace/provenance receipts, bulk trash stopped on first failure, and explicit local image settings were absent. Those gaps have now been implemented; the final section records the resulting architecture and quickstart records verification.

Preserve unrelated in-progress 034 work, including shared coverage-registry edits. New migrations sort after `20261205110000_tariff_recovery.sql`. Do not deploy migrations or mutate production. Refresh existing artifacts in place and retain historical task IDs and the 038 boundary.

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
| VI. Frontend composition | Existing shared UI primitives and token-derived styles; hosted bulk-trash results use the existing `team_operations`/`team_catalog_events` and sole `useTeamRealtime` owner. Hosted intents hold bulk retry keys; the upload IndexedDB journal is unchanged. Reconnect rereads the hosted snapshot without new polling. |
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
- **Partial bulk operations:** Hosted group/item state and existing `team_operations` receipts are authoritative. A new content-free `bulk_trash_changed` catalog marker uses the sole `useTeamRealtime` channel with a bounded urgent reread (the current generic one-second debounce is too slow for SC-003), then rereads after reconnect; the server holds initiator intent and stable retry keys. No new recurring client polling or subscription. A durable item identity prevents duplicate work.
- **Local images:** Null explicit selection preserves old random behavior. New jobs freeze selected assets; existing jobs are unaffected.
- **Diagnostics:** Record the last proven stage and delivery, not a click as success. Never collect task/file content, paths, finance amounts, external account IDs or provider payloads.

## Complexity Tracking

No constitution violation requires an exception. The feature remains broad; work is split into the slices above so each can be reviewed and verified independently.

## Implemented design reconciliation — 2026-10-20

- Migrations are `20261205120000_task_copy_idempotency.sql` through `20261205127000_task_cleanup_authority.sql`; no historical production migration was edited.
- Bulk intents and retry keys are hosted before execution, so the existing upload IndexedDB journal is unchanged. `useBulkTrash` is owned by `WorkspaceOperationsProvider`; current team generation checks discard stale reads. The existing Realtime owner gives bulk markers an urgent bounded refresh and retains ordinary debounce/reconnect behavior.
- Cleanup uses proof of task-scoped upload, server receipts, a conservative reference inventory/fence and provider readback. Unavailable workers remain waiting/claimed, not successful. Unknown provider results retain the fence until reconciliation. Permission and reference retention have separate reasons.
- Explicit image IDs are nullable, migrate from old settings, constrain the active pool and freeze in queued jobs. Invalid selections remain visible for correction; configuration validation rejects starting without silently substituting another image.
- Browser task days are the established calendar contract, because no workspace timezone exists. No new timezone setting is introduced.
- Diagnostic projection, typed UI lifecycle and `investigate` coverage are part of the implementation. Missing UI completion, an unavailable projection and as-of reconstruction remain explicit gaps.

Constitution recheck: no exception requested. Existing UI inventory/tokens, one transport owner, shared validators, service-only provider mutation and SELECT-only diagnosis are retained. Final gate and manual acceptance status are in quickstart.md.

## Follow-up validation remediation

The owner excluded live Windows acceptance; automated Windows contracts remain. The existing download-budget failure was corrected without changing its ceiling: procedural reconstruction preserves the complete backdrop geometry checksum, and HeroUI structure imports follow the actual component inventory and dependencies while retaining the full default theme. The shared local database failures were corrected by making `test:db` replay migrations in an ephemeral schema-only Supabase PostgreSQL container with no application data or active scheduler. The canonical pgTAP command passed all 834 checks. The owner subsequently deferred release-form verification and live/packaged acceptance to the combined pre-release pass. Current closure requires the normal verify only; it passed 14/14 gates with 6240 tests passed, 17 explicit skips and zero failures. All implementation tasks are complete.
