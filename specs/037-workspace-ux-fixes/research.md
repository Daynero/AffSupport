# Research: workspace UX fixes

## R1. Task copying and board state

**Decision:** Keep the existing `copy_team_tasks` content semantics (new task starts with fresh date/status/progress and no agent assignments; labels and attachment references are copied). Fix only board selection/focus and copied task visibility under active filters; never serialize board filters into the task-copy command. Give the paste attempt a stable idempotency key before broadening retries.

**Evidence:** `apps/web/src/team/tasks/useTaskClipboard.ts`, `TaskSpace.tsx`, `TaskFilterBar.tsx`, `supabase/migrations/20261009110000_team_task_copy.sql`. The copy hook already guards concurrent paste only within one mounted instance; a response lost after server commit can still lead to a duplicate on retry.

**Alternative:** Change copy to preserve source date/status. Rejected because the user's request concerns filter and selection behavior, and that would alter established task-copy semantics.

## R2. Attachment orphan cleanup

**Decision:** Separate immediate detach from safe cleanup. A server-owned intent has a 30-second grace period from the server's confirmed detach time. The existing action toast lasts 14 seconds; show Undo only when at least 20 seconds remain on the server deadline (14 seconds on screen plus six seconds of request margin), and cancel the intent atomically if pressed before that deadline. The existing scheduled `catalog-updater` worker claims due intents, retries after interruption, rechecks provenance and all live references under the appropriate lock, then moves only a verified app-owned orphan to the space's trash. A healthy worker must settle eligible work within five minutes after the grace period. If provenance/reference coverage is incomplete, retain the material with `cleanup_unverified`; never delete an external original. Link removal, trash confirmation and permanent storage reclamation are distinct outcomes.

**Evidence:** `TaskEditor.tsx` already detaches with an Undo toast; `team_task_attachments` references `team_materials`; `apps/web/src/team/materials/tail.ts` controls trash with companions. Immediate trash would make Undo a broken promise. Existing launch/catalog references in the same space make attachment count alone insufficient.

**Alternative:** Trash immediately after the last task attachment. Rejected due to Undo and other material consumers.

## R3. Bulk file deletion

**Decision:** Persist group and per-item trash receipts in a permission-checked hosted read model. Existing `team_operations` provides authoritative item receipts; a small group/item projection binds them to one bulk action and tracks queued items. Extend the closed `team_catalog_events.event_kind` list with content-free `bulk_trash_changed`; the existing `useTeamRealtime` owner handles this marker with a bounded urgent reread instead of its current one-second generic debounce, and rereads the hosted projection on reconnect/foreground. IndexedDB `workspaceOperationJournal` holds only the initiator's intent and stable retry keys, never authoritative success. Keep folder-descendant deduplication and material-tail behavior. Continue after per-item errors; display progress and a retry subset. Ensure `idempotencyKey` remains stable per item on retry and distinguish accepted vs confirmed trash. Under a controlled 50-item test, time from receipt or Realtime invalidation delivery to visible item state and require ≤1 second.

**Evidence:** `ExplorerShell.tsx:1350` currently loops sequentially, stops on first error, and only reports one toast; `WorkspaceOperationsProvider.tsx` and `workspaceOperationJournal.ts` already model initiator-local progress. `team_operations` stores server receipts and `useTeamRealtime.ts` already subscribes to team operations and catalog invalidations with an authoritative reread on reconnect.

**Alternative:** Parallelize all trash requests with only an IndexedDB journal. Rejected: obscures cross-session results, cannot prove provider postconditions after transport loss, and bypasses the hosted Realtime state rule.

## R4. Menus and chips

**Decision:** Reuse the shared popover/menu placement and design tokens. Test viewport clipping, portal boundaries, zoom, keyboard focus. For local operations, retain history and show busy animation only when active work exists. Finance toolbar work moved to 038.

**Evidence:** `BackgroundWorkChip.tsx` already computes `active` and `needsAttention`; `docs/DESIGN.md` governs components and tokens.

**Alternative:** Custom floating menu and CSS literals. Rejected by product design rules and duplicate focus logic.

## R5–R6. Accounts — transferred

Ordering, combined UI and archive now belong to [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md). Prior read-only-view assumptions are superseded; see [handoff](../038-unified-accounts/handoff.md) for retained evidence and new interaction references.

## R7. Local image selection

**Decision:** Add explicit single selected image per enabled start/end slot to `ImageEmbeddingSettings`, alongside the existing image galleries. Validate that the selection is in the corresponding gallery and not disabled; freeze selected assets into each queued job at enqueue/start as the queue already freezes the chosen embedding. Preserve existing random selection only when explicit selection is absent (migration/backward compatibility). The UI must show explicit vs random mode clearly.

**Evidence:** `ImageEmbeddingSection.tsx` currently toggles enabled gallery images, `packages/shared/src/types.ts` stores galleries and disabled IDs, and `apps/agent/src/queue/queue.ts` draws one image per slot for each job.

**Alternative:** Disable every other tile to force one image. Rejected because it repurposes an exclusion control and is easy to undo accidentally.

## R8. Diagnostic evidence

**Decision:** Reuse typed operation signals and the read-only analytics CLI. Add correlated lifecycle events and stable failure codes only for state-changing journeys. A success signal requires a confirmed read/postcondition or a durable receipt. Register each capability and distinguish missing/delayed signals. Do not include file names, paths, task content, image bytes, account IDs from external providers, or finance values.

**Evidence:** `specs/031-platform-autoanalytics/spec.md`, `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts`, `packages/shared/src/team/analytics.ts`.

**Alternative:** Only emit button-click events. Rejected because they cannot establish whether work reached the user.

## R9. Reconciliation and exhaustive reference inventory — 2026-10-20

**Decision:** Preserve existing layout, shared menu, chip and glossary implementations. Fix the remaining stateful paths. `TaskSpace.onPasted` previously reset filters and forced selection; it now preserves board preferences and clears selection after settling. `useTaskClipboard` keeps one session retry key until a confirmed readback and suppresses concurrent paste. `copy_team_tasks_once` binds that key to actor, team and ordered source IDs under an advisory transaction lock.

**Calendar evidence:** `TeamContextSnapshot` has no timezone setting. `useTasks.quickRangeValue` and `localTaskDayBounds` implement browser civil days. Spec terminology now names that contract instead of inventing a timezone property.

**References checked:** task attachments; material links in both directions; material companions; product catalogs and their videos; library folders/enrichments/requirements/results/attempts; upload batches/items; operation source/destination/result and replacement/version intent; restitch settings/sources/copies; Launch revisions/config/source/result JSON, revision catalogs, generation-step results, generation checkpoints and restitch preparation/operation references. Historical retained revisions remain references. A foreign key scan alone misses JSON snapshots.

**Authoritative seams:** `20261205122000_task_attachment_cleanup.sql` registers row fences on the current team/catalog/launch reference tables plus foreign-key consumers and JSON-bearing records and scans those records conservatively for the opaque material UUID or provider ID. Missing/disabled fences make a claim retain the file. Strings that resemble a reference can conservatively retain a file; no content leaves Postgres. Original successful-upload intent evidence is excluded only for the exact proven upload. Finalize grants belonging to that upload are not independent use; active grants for other purposes retain it. Audit/invalidation rows and bulk deletion intents are not live material consumers. Add any new reference-producing table to this inventory/fence seam before relying on cleanup; unknown ownership or consumer coverage must retain rather than trash.

**Ownership:** `begin_task_upload` accepts a task-scoped intent before upload. A successful service-owned, genuinely new upload operation captures exact material/provider/parent identity. Replacement, derivative, imported, legacy and folder attachments are not inferred to be owned. The shared task-drop folder alone is insufficient. Existing files without this evidence are retained with `cleanup_unverified`.

**Fence and recovery:** Detach returns the server deadline and a durable cleanup receipt. Undo locks the same task/material and atomically restores the link or rolls back. A new detach cancels an earlier waiting intent. Claim locks the material before the intent, rechecks consumers and permissions, and creates a running trash operation. New references lock that material and refuse while the durable claim exists. A provider timeout leaves the fence and lease in place; recovery rereads the exact provider postcondition. A moved file is retained. The existing catalog-updater owner dispatches due cleanup even with no browser or ordinary catalog round. Three claims per tick bound the lane; production backlog/latency is not a measured capacity guarantee.

**Bulk model:** Existing library upload batches require upload-only offer/geo/language fields and are not a suitable trash model. A narrow hosted group/items projection instead joins `team_operations`; only a succeeded operation can confirm trash. Unknown requests keep the exact key; an authoritative failed/canceled receipt permits a new bounded attempt key. Server recursion deduplicates selected descendants. Existing material-tail behavior is preserved. The provider runs at most three item requests concurrently and rereads hosted results through the sole workspace Realtime owner. No new subscription or polling loop is added. Hosted intents already survive reload, so the upload-specific IndexedDB journal is left unchanged rather than duplicating trash authority in it.

**Diagnostics:** `analytics_workspace_operations` is a revoked-by-default, SELECT-only projection. `investigate` reports bounded receipts and explicit missing-view, missing-delivery, truncation and historical-as-of limitations. Typed browser flows distinguish requested, confirmed and visible states. A visible retained outcome is not a successful trash. `IMAGE_UNAVAILABLE` remains the existing closed agent failure code and now points to settings selection validation as well as the queue/image store.

**Alternatives rejected:** last-attachment-count deletion; browser assertions of file origin; JSON-blind foreign-key-only checks; changing the upload-batch domain; local success flags as receipts; new Realtime owners or recurring polling; silently replacing an unavailable explicit image.

**Schema evolution:** The reference-table registry also discovers foreign-key and JSON consumers outside the historical name prefixes (including the existing companion orphan-cleanup table). A new table without its fence invalidates coverage and retains work with `cleanup_unverified`. The service rechecks coverage, references, identity and current rights immediately before a provider mutation. Future reference-producing schema changes must still participate in this seam before release.

**Image diagnostic path:** Frozen jobs preserve explicit/random mode independently of later settings. Correlated compression events expose only `explicit_start_image` and `explicit_end_image` booleans through the client allowlist, server guard and read-only sanitizer; old jobs without mode fields remain unknown. The guard extension preserves the later 038 finance vocabulary; its contract regression catches drift.

**Actual concurrency evidence:** A disposable local PostgreSQL database with the migration chain was exercised through two held-lock sessions. A reference committed before claim caused retention; a reference attempted after a committed claim was refused. No provider credential or production record was used.
