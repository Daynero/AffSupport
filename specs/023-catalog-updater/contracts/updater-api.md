# Contract — Catalog updater

Existing envelopes and error vocabulary (`TeamEdgeResult`, `TeamErrorCode`, `details.reason`). D1
surfaces first; D2 surfaces are marked.

## Client RPCs (D1)

### `list_team_product_catalogs(p_team uuid)` → rows

Requires `view`. Live catalogs only (sheet and video active).

```ts
interface CatalogRegistryRow {
  catalogId: string; // sheet material id
  name: string; // sheet name
  sheetUrl: string;
  videoId: string;
  videoName: string;
  folderName: string | null; // null = space root
  productCount: number;
  createdAt: string;
  lastUpdatedAt: string | null;
  updateCount: number;
  inUpdater: boolean;
  lastUpdateError: string | null; // TeamErrorCode
}
```

### `get_team_catalog_updater(p_team uuid)` → row or nothing

Requires `view`.

```ts
interface CatalogUpdaterState {
  state: 'running' | 'stopped';
  interval: '1h' | '1d' | '1w';
  restitch: boolean;
  nextRunAt: string | null; // server time; the chip counts down to it
  startedAt: string | null;
  catalogCount: number;
  failingCount: number; // items with last_update_error after 3 attempts
  spareReadyCount: number | null; // D2; null when restitch is off
  device: { label: string; online: boolean; tooOld: boolean } | null; // D2
  serverNow: string; // for clock-skew correction of the countdown
}
```

### `save_team_catalog_updater(p_team, p_catalogs uuid[], p_interval text, p_restitch boolean)`

Requires `process`. Starts a stopped updater or changes a running one.

- `PERMISSION_DENIED` (42501) without `process`.
- `INVALID_INPUT` (22023): empty list, a catalog not live in this space, interval not in the set,
  `p_restitch = true` in D1 or without an online, new-enough device in D2.
- On start: `next_run_at = now() + interval`. On interval change: same. Otherwise unchanged.
- Catalogs removed from the list leave the updater (D2: their jobs cancelled, spares deleted).
- Returns `CatalogUpdaterState`.

### `stop_team_catalog_updater(p_team)`

Requires `process`. State `stopped`, `next_run_at` null, items removed (D2: jobs cancelled, spares
deleted). Returns `CatalogUpdaterState`. Idempotent.

## Worker (D1)

### `POST /functions/v1/catalog-updater`

- Header `x-catalog-sync-secret` (the existing `CATALOG_SYNC_SECRET`); anything else → 401.
- Body `{ "scheduled": true }`.
- One invocation, ~8 s budget:
  1. `service_open_catalog_updater_rounds`.
  2. `service_claim_catalog_updater_items(worker, 10, 60)`.
  3. Per item: Drive client for the credential → rebuild rows from the record with
     `update_count + 1` IDs (and D2 video link) → `updateConvertedFile` in place → verify returned id
     and mime → `service_complete_catalog_update`. On error → `service_retry_catalog_update` with
     back-off 1, 5, 15 minutes, then every 15 minutes.
  4. Stop claiming when the budget is spent.
- Response `{ ok: true, value: { rounds, claimed, updated, failed } }`.

## Drive client additions

- D1 `updateConvertedFile({ fileId, resourceKey, sourceMimeType, targetMimeType, bytes })` —
  multipart PATCH with conversion; 10 MB, 60 s; returned `id` and `mimeType` must match.
- D2 `deleteFile(fileId)` — permanent; only called with ids from `team_catalog_restitch_copies`.

## D2 — device and agent surfaces

### `POST /functions/v1/updater-devices/enroll` (user JWT)

Body `{ teamId, installId, label, build, toolContracts }`. Requires `process`; the agent's contracts
must include `teamUpdaterRestitch ≥ 1`. Revokes the space's previous device. Returns
`{ deviceId, secret }` — the secret once.

### Agent route `POST /api/team/updater/enroll` (session token + entitlement)

Body `{ deviceId, secret, cloudBaseUrl }`. Stores `{ deviceId, secret, cloudBaseUrl }` at 0600 in the
support directory; starts the runner. `DELETE` removes it and stops the runner.

### `POST /functions/v1/updater-agent/claim` (header `x-soty-device-secret`)

Body `{ deviceId, build, toolContracts, busy }`. Updates `last_seen_at`. Returns `{ job: null }` or
`{ job: { jobId, leaseToken, operationId, toolId: 'restitch', options: { defaults, prepared },
sourceGrant, finalizeGrant, transferUrl, cloudBaseUrl } }` — the grants minted as the device's actor
through the shared `process/start` core. Revoked device, removed member or blocked account →
`PERMISSION_DENIED`.

### `POST /functions/v1/updater-agent/heartbeat`

Body `{ deviceId, jobId, leaseToken }`. Renews the lease, updates `last_seen_at`. Returns
`{ cancel: boolean }`; `cancel: true` → the agent cancels the local operation.

### `POST /functions/v1/updater-agent/complete`

Body `{ deviceId, jobId, leaseToken, outcome: 'finalized' | 'failed', errorCode?, discovered? }`.
Records prep data and failure reasons; success itself is established by `process/output/finalize`,
which links the output as the catalog's spare copy.

### Capability

`AGENT_TOOL_CONTRACTS.teamUpdaterRestitch = 1`; `teamUpdaterRestitchSupported(contracts)` helper.
Never added to `WEB_TOOL_REQUIREMENTS`.
