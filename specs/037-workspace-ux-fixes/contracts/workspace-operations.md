# Workspace operation contracts — implementation 2026-10-20

Implemented locally; no deployment is implied. Shared validators are in `packages/shared/src/team/{bulk-trash,task-cleanup}.ts`.

## Copy tasks

- Input: `teamId`, ordered unique task IDs (1–100), `idempotencyKey`.
- Output: ordered new task IDs; the request key identifies the durable actor/team-scoped receipt.
- Same team/key/payload returns the same result; same key with a different payload fails. Permission and source existence are validated atomically. UI selection is never input or output.
- Failure codes include invalid input, permission denied, missing source, conflict, and result unknown after transport loss. A result-unknown state is reconciled before retry.

## Detach and orphan cleanup

- Input: team/task/material IDs. Replaying a detach whose link is already absent returns its saved receipt. A genuine reattachment followed by detach creates a new receipt. Result is `{id,materialId,undoUntil,state,reason}` with `waiting | claimed | retained | trashed | cancelled`; `undoUntil` is the server detach time plus 30 seconds.
- The action toast lasts 14 seconds. Offer Undo only if at least 20 seconds remain when the detach response reaches the browser, leaving six seconds after the toast for request delivery. Undo before `undoUntil` atomically cancels the intent and reattaches; after expiry, never show it as guaranteed restoration.
- The existing scheduled catalog-updater invocation claims due intents at least once per minute, retries interrupted/failed claims with bounded backoff, and rereads the receipt on reconnect. When healthy it confirms trash or retention within five minutes of deadline; if unhealthy it reports waiting/retry rather than success.
- Server rechecks provenance and all supported live references at cleanup claim. Unknown provenance/reference coverage yields `retained: cleanup_unverified`. `trashed` is a confirmed move to the space's trash, not evidence that storage quota has been reclaimed.

## Bulk trash

- Input: team ID, stable group ID, ordered material IDs after folder-descendant deduplication. A permission-checked server write creates hosted group/item intents; each accepted trash action links to the existing `team_operations` receipt.
- Authoritative query result: group state and per-item `{itemKey, materialId, operationId?, state, code?, confirmedAt?}`. Hosted group/items carry intent and stable retry keys; the upload-specific IndexedDB journal is unchanged. Retries target failed or reconciled unknown items with the same item identity. Unknown requests keep their exact key; a confirmed failed/canceled operation permits the next bounded attempt key. A confirmed item never reverts to queued.
- Item/group changes emit only content-free `bulk_trash_changed` catalog invalidation markers into the existing `useTeamRealtime` subscription; extend the event-kind constraint and use a bounded urgent reread because the current generic one-second debounce alone cannot satisfy the one-second UI target. After a marker, reconnect or foreground, the sole subscription owner rereads the authoritative hosted snapshot; no recurring client polling or duplicate subscription is added.
- Completion distinguishes confirmed items, failures, running work and unknown requests; a server-canceled item is a failed terminal eligible for an explicit retry. For 50 items a controlled test measures from receipt/Realtime delivery to visible state, with a maximum of one second; disconnected items explicitly await reconciliation.

## Accounts/finance contracts — transferred

Ordering, archive and combined account view are owned by [038](../../038-unified-accounts/spec.md). The prior read-only projection contract is superseded by a unified editable UI; its data-integrity constraints remain planning input in [handoff](../../038-unified-accounts/handoff.md).

## Local image choice

- Settings patch adds nullable selected start/end image IDs, validated against the respective gallery and disabled set. Null preserves random choice. Queue request freezes the resolved asset per slot; unavailable explicit selection yields a stable validation failure before spawning work.

## Diagnostic envelope

- Each state-changing contract reports `flowId`, `operationId`, `attemptId`, stage, outcome, stable code, and delivered/observed result where applicable. Bulk results include bounded counts. No task content, file name/path, image bytes, finance amount, external account ID or provider payload is included.

## Concrete interfaces

- `copy_team_tasks_once(p_team,p_tasks,p_request)` returns `uuid[]`.
- `begin_task_upload(p_team,p_task,p_request)` accepts provenance intent before the managed upload; the browser cannot register ownership after the fact.
- `detach_task_material_safely`, `undo_task_material_detach`, `list_task_attachment_cleanup` return validated cleanup receipts. Retention reasons are `cleanup_unverified`, `cleanup_referenced`, or `cleanup_forbidden`; a provider uncertainty is `cleanup_pending`.
- `start_team_bulk_trash`, `prepare_team_bulk_trash_item`, `mark_team_bulk_trash_request`, `list_team_bulk_trash` form the hosted trash contract. Client request markers cannot assert success. Only joined `team_operations` can do so.
- Service-only cleanup claim/settle RPCs and the existing catalog-updater worker own provider trash and reconciliation.
- `analytics_workspace_operations` exposes only bounded opaque identity, stage/reason/count/time evidence to the SELECT-only role. Browser visibility is separate typed lifecycle evidence. Explicit image telemetry contains only two booleans; historical frozen jobs without mode fields remain unknown.
