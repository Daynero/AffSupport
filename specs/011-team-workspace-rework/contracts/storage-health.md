# Contract — Storage health chip

Exactly one state is shown. Priority when several are true: `attention` > `disconnected` >
`waiting_provider` > `indexing` > `preparing` > `connected`.

| State | Copy (en) | Source | Click action |
| --- | --- | --- | --- |
| `connected` | "Storage up to date · 3 min ago" | `state = 'connected'`, no pending index, no pending thumbnails; `last_reconciled_at` | detail: root/selections, counts, "Check now" (`request_team_catalog_resync`) |
| `indexing` | "Indexing · 1,240 files so far · 37 folders remaining" | connection `initial_sync_state ≠ 'complete'` or any folder with `folder_indexed_at null` | detail with per-selection progress; pause not offered (server-side) |
| `preparing` | "Preparing previews · 812 of 1,050" | `thumbnail_state = 'pending'` count > 0 or landing renders pending | detail; "Pause on this computer" stops the agent render loop only |
| `waiting_provider` | "Waiting for Google Drive…" | any `team_operations` in `stage = 'waiting_provider'` within 10 min | detail explains rate limit; nothing to do |
| `attention` / `needs_reauth` | "Storage needs the owner to reconnect" | connection `state = 'needs_reauth'` | owner: one-click reconnect (`start` with same root); others: names the owner |
| `attention` / `root_missing` | "The connected folder was deleted" | `state = 'root_missing'` | owner: "Restore from trash" / "Choose another folder" |
| `attention` / `permission_lost` | "Soty lost access to the folder" | provider 403 on root proof | owner: reconnect |
| `attention` / `quota` | "Google Drive quota is exhausted" | provider `storageQuotaExceeded` | detail only |
| `disconnected` | "No storage connected" | no connection or `detached` | owner: connect flow |

Rules: visible on every team screen (FR-031); read-only data stays visible in every state;
`aria-live="polite"` on state change; copy keys `teamStorage*` in `i18n.ts` with `uk`
plurals; refresh on `sync_state`/`storage_state` events and every 60 s.
