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

## R4. Menus, chips, and finance toolbar

**Decision:** Reuse the shared popover/menu placement and design tokens. Test viewport clipping, portal boundaries, zoom, keyboard focus. For local operations, retain history and show busy animation only when active work exists. Make the existing `FinanceToolbar` sticky inside the correct scroll container, accounting for the workspace header and small screens.

**Evidence:** `BackgroundWorkChip.tsx` already computes `active` and `needsAttention`; `FinanceToolbar.tsx` is the current control; `docs/DESIGN.md` governs components and tokens.

**Alternative:** Custom floating menu and CSS literals. Rejected by product design rules and duplicate focus logic.

## R5. Socials, ad accounts, and ordering

**Decision:** Model two persisted order levels: `team_accounts` (socials) and `team_account_agents` (ad accounts / РК). Mutations use a versioned, atomic reorder with membership validation and conflict response; readers sort by persisted rank with deterministic ID fallback. Keyboard move controls accompany pointer drag/drop. New rows append to their group.

**Evidence:** `specs/035-launches/spec.md` identifies the current model; `packages/shared/src/team/accounts.ts` currently sorts by natural name, and `useAccounts.ts` reapplies that sort after reads and writes. Simple UI-only ordering would be lost immediately.

**Alternative:** Browser-local order. Rejected because the requested order is shared across team members.

## R6. Combined account/launch/finance view and archive

**Decision:** Build a read model grouped by social and ordered by ad account. Join launches through stable ad-account identity and finances through `agentRowId` and existing period placements. Show unmatched and stale-snapshot rows separately, never infer ownership from name or suffix. Add a soft archive state to socials, with an explicit archived view and restore. Historical joins include archived socials; active selectors omit them. Define active launch handling before allowing archive, with a clear refusal or explicit resolution path.

**Evidence:** `FinanceWorkspace.tsx` uses `agentRowId` plus placement windows; launch configuration captures social/ad-account snapshots; `team_accounts` has no archive/order fields today.

**Alternative:** Join by visible label. Rejected because renames and moved РК make it ambiguous.

## R7. Local image selection

**Decision:** Add explicit single selected image per enabled start/end slot to `ImageEmbeddingSettings`, alongside the existing image galleries. Validate that the selection is in the corresponding gallery and not disabled; freeze selected assets into each queued job at enqueue/start as the queue already freezes the chosen embedding. Preserve existing random selection only when explicit selection is absent (migration/backward compatibility). The UI must show explicit vs random mode clearly.

**Evidence:** `ImageEmbeddingSection.tsx` currently toggles enabled gallery images, `packages/shared/src/types.ts` stores galleries and disabled IDs, and `apps/agent/src/queue/queue.ts` draws one image per slot for each job.

**Alternative:** Disable every other tile to force one image. Rejected because it repurposes an exclusion control and is easy to undo accidentally.

## R8. Diagnostic evidence

**Decision:** Reuse typed operation signals and the read-only analytics CLI. Add correlated lifecycle events and stable failure codes only for state-changing journeys. A success signal requires a confirmed read/postcondition or a durable receipt. Register each capability and distinguish missing/delayed signals. Do not include file names, paths, task content, image bytes, account IDs from external providers, or finance values.

**Evidence:** `specs/031-platform-autoanalytics/spec.md`, `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts`, `packages/shared/src/team/analytics.ts`.

**Alternative:** Only emit button-click events. Rejected because they cannot establish whether work reached the user.
