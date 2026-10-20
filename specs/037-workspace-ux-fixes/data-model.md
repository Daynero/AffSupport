# Data model: workspace UX fixes

Account order/archive, launch and finance projection are now owned by [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md); see its handoff for prior design inputs.

## Existing entities and planned fields

| Entity | Existing identity | Planned addition / invariant |
| --- | --- | --- |
| Task and copy | Existing task ID | Copy operation idempotency key → ordered result IDs; no board filter fields. Copy shares attachment material references. |
| Task attachment | `(team_id, task_id, material_id)` | Detach is immediately reversible. Orphan cleanup intent references material, detach receipt and server `cleanup_not_before = detached_at + 30 seconds`, not task content. |
| Material | Existing material ID and provenance | Cleanup eligibility requires app-owned origin and zero live references across all supported consumers at claim time; unknown origin means retain. Cleanup states: waiting → claimed → trashed / retained; cancelled by atomic Undo; claimed with cleanup_pending after an uncertain provider result. `trashed` means confirmed in the space's trash, not storage quota released. |
| Hosted bulk trash group/item | Group ID, team ID, stable item key/material ID and per-item `team_operations` receipt ID | Permission-checked server projection is authoritative. Item states: queued → running → confirmed / failed / unknown; group outcome is derived from those authoritative items. Retry starts only failed or reconciled unknown items and does not duplicate confirmed trash. Content-free invalidation triggers an authoritative reread. |
| Initiator-local bulk intent | Hosted group ID and item retry keys | Hosted intents remember selected items and retry keys across reload; the existing upload journal does not duplicate trash state. |
| Image embedding settings | Existing start/end galleries and disabled IDs | Nullable `selectedStartImageId` and `selectedEndImageId`; null means current random behavior. Non-null ID belongs to correct active gallery. |
| Queued image embedding | Existing frozen `startImage`/`endImage` | At queue start, explicit selected asset is frozen; later settings changes do not alter a queued job. |
| Diagnostic attempt | Correlated flow/operation/attempt IDs | Lifecycle and delivery receipt; bounded counts and stable reason codes only. Missing evidence is explicit. |

## Important transitions and migration rules

- A detach acknowledges link removal before cleanup; Undo before the server deadline cancels the cleanup intent. The current 14-second action toast is shown only when at least 20 seconds remain before that deadline, leaving six seconds of request margin. A concurrent new reference makes cleanup retain the file. The scheduled existing catalog-updater invocation claims due work at least once per minute; retryable failures use backoff and stay visible.
- A browser reload or Realtime reconnect reconstructs item results from the hosted projection and `team_operations` receipts. The hosted group restores trash intent/keys; IndexedDB remains scoped to existing uploads. Unconfirmed results are `unknown`/recovering until a postcondition check settles them; no new polling loop or Realtime subscription is created.
- Existing image settings migrate with both explicit IDs null; existing queued jobs retain their frozen selections. Removing a selected image clears or invalidates its selection visibly before any new job starts.

## Boundaries

- No raw content, file paths, finance amounts, or provider payloads enter analytics.
- A material's reference set needs a documented exhaustive inventory before any cleanup implementation. A reference type without an authoritative query blocks automatic trash for that material.
