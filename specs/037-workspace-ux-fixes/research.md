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

## T002 trace: task dates, copy, local trash, diagnosis

- Copy starts in `useTaskClipboard.ts`: native copy serializes only team and task IDs, paste validates them, and `sessionStorage` retains a request UUID across a lost response or tab reload. `TaskSpace.tsx` clears the in-memory selection after paste settles and resets board filters after a confirmed copy. `teamApi.copyTasks` calls `copy_team_tasks`; migration `20261203100000_task_copy_idempotency.sql` owns the server receipt and replay check. The RPC result is a list of new task IDs. No agent-readable copy receipt query exists yet; T011 must distinguish confirmed from unknown transport outcomes.
- Date presets are created by `quickRangeValue` in `useTasks.ts`, displayed in `TaskDateFilter.tsx`, and converted to instant/day bounds by `taskFilterBounds` and `localTaskDayBounds` before the task read. These currently use the browser's local timezone. The team model has no persisted space timezone; T008 must define one or explicitly reuse an existing authoritative setting before promising consistent yesterday/today across members.
- Explorer bulk trash starts in `ExplorerShell.tsx:trashRows`, which skips descendants of a selected folder but runs `trashMaterialWithTail` sequentially and breaks on first error. `workspaceOperationJournal.ts` stores local IndexedDB intents and per-item operation IDs; `WorkspaceOperationsProvider.tsx` reconciles those IDs through `teamApi.getOperation`. This does not yet represent a hosted bulk-trash group. `useTeamRealtime.ts` listens to `team_operations` and `team_catalog_events`, then delays the authoritative reread by one second, which consumes the full SC-003 visibility bound before rendering.
- `scripts/analytics/coverage-registry.ts` and `investigate.ts` describe existing operation signals and blind spots, but have no hosted copy or bulk-trash group receipt projection. T004–T006 and T011/T024 must add bounded identifiers, postcondition checks, and missing-signal paths without task content, file names, or paths.

## T001 trace: material references and upload provenance

The clean 037 schema has no task-owned marker on `team_materials`. `TaskEditor.tsx` uploads to the space's task-drop folder using `drive-ops/ensure-task-drop-folder`, then separately attaches the returned material ID. Folder location is not proof of task ownership: another upload can land in that folder, and a failed attach can leave an unattached upload. The marker in T013 must be written only for a verified upload operation and bound to its exact material/team; indexed catalog provenance or attachment count alone cannot authorize trash.

The current schema's foreign keys to `team_materials` cover these live-reference families (checked against `pg_constraint` on an isolated database built from this branch):

- Task: `team_task_attachments`.
- Material graph and generated companions: `team_materials.companion_of`, `team_material_links`, `team_product_catalogs`, `team_product_catalog_image_sources`, `team_catalog_restitch_copies`, `team_restitch_sources`.
- Catalog/library work: `team_library_requirements`, `team_library_results`, `team_material_restitch_prep`, `team_landing_renders`, `private.team_material_enrichments`, `private.team_library_attempts`, `private.team_library_folders`, `private.team_material_group_intents`.
- Pending operations and grants: `team_operations` (source/result/destination), `private.team_operation_intents` (replacement/version), `private.team_transfer_grants` (material/destination), `team_upload_batch_items`.
- Existing orphan queue: `private.orphan_cleanups` (for companion cleanup, **not** task uploads).

Additional material IDs without foreign keys occur in `team_catalog_updater_items`, `private.catalog_restitch_jobs`, `private.catalog_restitch_operations` and `private.catalog_update_progress`. `team_catalog_events` is historical invalidation, not a live consumer, but the other rows can represent pending work. The cleanup claim must inspect these states or retain as `cleanup_unverified`. It must also inspect the live lifecycle of referenced rows, not count historical or retired rows blindly.

Drive ownership is established by the exact `team_materials.connection_id` → `team_drive_connections` credential/root and the hosted upload operation's confirmed result, not by a matching name, path or folder. A recheck must lock the material and intent, verify `team_id`, `lifecycle = 'active'`, `drive_file_id`, marker provenance, and all live references in the same transaction before an external trash call. The Drive call and postcondition remain separate from that transaction; a lease/recovery receipt must reconcile transport loss before reporting success.

The 035 Launches schema and code are still uncommitted outside this isolated branch. Its source references may not carry foreign keys or may live in snapshots. The inventory is exhaustive for the clean 037 schema, **not** for a combined product with Launches. Until those references are integrated and checked, cleanup of a task upload must resolve to `cleanup_unverified` rather than infer that no launch uses it. This is the safety boundary for T012–T018.

## T003 trace: launch, РК and finance identity

The uncommitted 035 Launches workspace was inspected read-only; no Launches files were copied into this branch. A launch's current `team_launches.draft_config.agentRowId` is the stable UUID of `team_account_agents.id`. `private.launch_source_snapshot` also records both `agentRowId` and its then-current `accountId`; revisions retain `config` and `sources` snapshots. The existing `list_launches` projection follows the current live agent row to its social, so that projected social changes after an РК move and becomes blank after deletion. The combined history must prefer the immutable revision/source snapshot for the launch's historical social and keep an unmatched reason when the row or snapshot is absent. It must never infer identity from `social`, `agentId`, or the displayed three-character suffix.

Finance values and events use `agent_row_id`; each value also carries `placement_id` and `account_id` from the placement effective on the entry date. `team_agent_placements` has `starts_on` and `ends_on` and the move RPC closes the old placement and opens a new one. A period report must attribute each value to its recorded placement and include both sides of a mid-period move. `amount_cents = 0` is a recorded zero; no matching value row is no data. An archived social must remain resolvable by ID for history even when excluded from active pickers. Deleting an РК currently removes the live agent row; history then needs snapshot IDs/placement references or an explicit unmatched reason, not a join through the deleted row.

The Launches migrations are absent from this branch, so T035–T038 and T044–T048 must be built only after a committed Launches base can be integrated into the isolated 037 worktree without importing unrelated in-progress changes. The trace above defines the join contract but does not claim the combined query is verified against a merged schema.
