# Contract: Catalog synchronization

This document defines observable behavior and payload shapes. Names are conceptual; implementation may retain existing RPC names when their validation and behavior match.

## Request a folder reconciliation

Caller: authenticated owner/admin.

Input:

```ts
type RequestFolderSync = {
  teamId: string;
  folderId: string; // provider folder id already present in the team catalog
  idempotencyKey: string;
};
```

Accepted result:

```ts
type FolderSyncAccepted = {
  jobId: string;
  scopeFolderId: string;
  state: 'queued' | 'running';
  joinedExisting: boolean;
};
```

Rules:

- Same active `(connection, scopeFolderId)` returns the same job and `joinedExisting: true`.
- Acceptance does not claim completion.
- Scope is the folder and its descendants. It does not advance the connection change cursor.
- Stable errors: `PERMISSION_DENIED`, `NOT_FOUND`, `DRIVE_NOT_CONNECTED`, `SYNC_UNAVAILABLE`, `INVALID_INPUT`.

## Read operation status

Caller: any current team member with `view`.

```ts
type FolderSyncStatus = {
  jobId: string;
  scopeFolderId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  phase: 'listing' | 'reconciling' | 'replaying_changes' | 'done';
  discoveredFiles: number;
  completedFolders: number;
  pendingFolders: number | null;
  lastProgressAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
};
```

The status is a safe projection: no credentials, raw provider cursor, lease owner or unrelated job details.

## Catalog invalidation

Existing authorized catalog events invalidate affected reads. Moves invalidate
old/new parents. Subscribe/reconnect/visibility reads authoritative visible
snapshots; events during reads mark dirty. Event IDs are not contiguous or
commit watermarks. No event replay/cursor API or new polling is added.

## Worker guarantees

- Only the canonical incremental job commits the provider change cursor.
- A folder is marked indexed/reconciled only after every page completes.
- Complete pagination produces candidates only. Current provider parent/trash
  must prove absence; ambiguous 403/404 means unavailable. Commit checks current
  lease epoch and unchanged catalog mutation baseline.
- Scan generations isolate rejected-page-token restarts; incompleteSearch or
  invalid metadata prevents complete coverage. Durable frontier never truncates
  wide trees. Finite completion waits for canonical replay after listing.
- Same-scope requests join regardless of reason; ancestor joins require the
  branch still ahead, otherwise enqueue one follow-up. Old pages cannot overwrite
  newer material mutations.
- Discovering a folder that may have unseen descendants idempotently creates a finite subtree scan.
- A successful checkpoint clears consecutive failure count. Retry ceilings use consecutive failures, not total claims.
- Terminal job completion publishes a catalog/sync event in the same transaction as its final state.
