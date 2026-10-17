# Workspace operation contracts (design, not deployed API)

These contracts describe required behavior; exact RPC names and wire fields are chosen during implementation after checking existing typed seams.

## Copy tasks

- Input: `teamId`, ordered unique task IDs (1–100), `idempotencyKey`.
- Output: ordered new task IDs and a durable operation/attempt ID.
- Same team/key/payload returns the same result; same key with a different payload fails. Permission and source existence are validated atomically. UI selection is never input or output.
- Failure codes include invalid input, permission denied, missing source, conflict, and result unknown after transport loss. A result-unknown state is reconciled before retry.

## Detach and orphan cleanup

- Input: team/task/material IDs and idempotency key. Result separates `detached` from `cleanup: waiting_for_undo | due | checking | retained | trashed | retry_wait | failed`, with server `cleanupNotBefore = detachedAt + 30 seconds` and a stable reason code.
- The action toast lasts 14 seconds. Offer Undo only if at least 20 seconds remain when the detach response reaches the browser, leaving six seconds after the toast for request delivery. Undo before `cleanupNotBefore` atomically cancels the intent and reattaches; after expiry, never show it as guaranteed restoration.
- The existing scheduled catalog-updater invocation claims due intents at least once per minute, retries interrupted/failed claims with bounded backoff, and rereads the receipt on reconnect. When healthy it confirms trash or retention within five minutes of deadline; if unhealthy it reports waiting/retry rather than success.
- Server rechecks provenance and all supported live references at cleanup claim. Unknown provenance/reference coverage yields `retained: cleanup_unverified`. `trashed` is a confirmed move to the space's trash, not evidence that storage quota has been reclaimed.

## Bulk trash

- Input: team ID, stable group ID, ordered material IDs after folder-descendant deduplication. A permission-checked server write creates hosted group/item intents; each accepted trash action links to the existing `team_operations` receipt.
- Authoritative query result: group state and per-item `{itemKey, materialId, operationId?, state, code?, confirmedAt?}`. Browser IndexedDB carries only intent and stable retry keys. Retries target failed or reconciled unknown items with the same item identity; a confirmed item never reverts to queued.
- Item/group changes emit only content-free `bulk_trash_changed` catalog invalidation markers into the existing `useTeamRealtime` subscription; extend the event-kind constraint and use a bounded urgent reread because the current generic one-second debounce alone cannot satisfy the one-second UI target. After a marker, reconnect or foreground, the sole subscription owner rereads the authoritative hosted snapshot; no recurring client polling or duplicate subscription is added.
- Completion distinguishes all succeeded, partial, all failed, and canceled. For 50 items a controlled test measures from receipt/Realtime delivery to visible state, with a maximum of one second; disconnected items explicitly await reconciliation.

## Reorder socials and ad accounts

- Input: team ID, scope (`socials` or `ad_accounts` with parent social ID), complete ordered ID list for that scope, expected version, idempotency key.
- Server validates permission, exact same membership and parent for each ID, rejects duplicates, writes ranks atomically, increments version, returns the canonical ordered IDs/version.
- A version conflict returns canonical current order and version; client renders it and offers explicit retry. Moving a РК across socials remains a separate existing move operation with destination rank assigned atomically.

## Archive social

- Input: team/social ID, expected version, desired archived state, idempotency key.
- Result returns canonical state/version; historical rows are never deleted. If active launches cannot safely continue under archive, reject with a stable `ACTIVE_LAUNCH` code and a route to resolve them.
- List APIs expose archived state and allow explicit active/archived/all scope; active selectors default to active.

## Combined account view

- Input: team ID and inclusive finance period.
- Output: ordered social groups, each with ordered РК rows, per-РК launches and finance values, and an unmatched set with reason. `null` denotes no data; `0` denotes a known zero. Historical archived socials remain resolvable.
- Pagination or aggregate totals must derive from the same canonical ordered membership, never from client-only visible rows.

## Local image choice

- Settings patch adds nullable selected start/end image IDs, validated against the respective gallery and disabled set. Null preserves random choice. Queue request freezes the resolved asset per slot; unavailable explicit selection yields a stable validation failure before spawning work.

## Diagnostic envelope

- Each state-changing contract reports `flowId`, `operationId`, `attemptId`, stage, outcome, stable code, and delivered/observed result where applicable. Bulk results include bounded counts. No task content, file name/path, image bytes, finance amount, external account ID or provider payload is included.
