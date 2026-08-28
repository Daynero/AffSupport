# Contract — Edge Functions

Envelopes are unchanged: success returns the state snapshot; failure returns
`{ error: <TeamErrorCode>, retryable, details? }`. No provider bodies in logs or errors.

## `drive-connect`

| Action | Who | Input | Output | Notes |
| --- | --- | --- | --- | --- |
| `start` (existing) | owner | team | authorization URL | scope becomes `https://www.googleapis.com/auth/drive.file` (+ `drive` only when `DRIVE_RESTRICTED_SCOPE_APPROVED=true`); `include_granted_scopes=true` kept |
| `picker_token` **new** | owner / `manage_members` | team | `{ accessToken, expiresAt, appId, apiKey }` | minted from the Vault refresh token; ≤ 1 h; never stored client-side beyond memory; refused unless connection `state ∈ {pending, connected, root_missing}` |
| `choose_root` **new** | owner | `{ driveFolderId, resourceKey, name, driveId? }` from Picker | connection snapshot | replaces the browse-then-choose flow; validates via `validateRootCandidate`; creates the root selection |
| `add_selection` / `remove_selection` **new** | owner / `manage_members` | folder from Picker | selections list | only meaningful under R1 outcome B; hidden in UI under A |
| `restore_root` **new** | owner | — | snapshot | untrash root via provider; `ROOT_MISSING` if not restorable |
| `readiness` (existing) | any | — | readiness | + refuses restricted scope on production origin without approval signal (`RESTRICTED_SCOPE_NOT_APPROVED`) |
| `refresh` (existing) | service | — | — | proactive: called when `access_expires_at − now < 10 min`; `invalid_grant` ⇒ `needs_reauth` + `storage_state` event |

## `drive-transfer`

| Action / path | Who | Input | Output | Notes |
| --- | --- | --- | --- | --- |
| `thumbnail_session` **new** | member | team | `ThumbnailSession` | 15 min; hashed in `team_operations`; read bound 5,000 |
| `GET …/thumbnail?material=&session=` **changed** | member | session token | image bytes (`Cache-Control: private, max-age=900`) | verifies session + membership + lifecycle per read; serves bucket bytes; on miss fetches `thumbnailLink` once and caches; `THUMBNAIL_SESSION_EXPIRED` / 404 typed |
| `GET …/range` (existing) | member | grant | bytes | unchanged (video playback) |
| `landing_render_*` (existing) | agent | — | — | unchanged; used by the background loop too |

## `preview-warm` **new**

| Trigger | Behaviour |
| --- | --- |
| `catalog-sync` on `folder_indexed`; scheduled tick every 5 min | `service_claim_preview_warm(50)` → for each: `files.get(fields=thumbnailLink,version)` → fetch bytes (≤ 4 MiB, allowed mime list) → bucket path `<team>/<material>/<version>` → `service_commit_thumbnail`. Drive 403/429 ⇒ backoff, operation `stage = 'waiting_provider'`, no failure. Missing `thumbnailLink` ⇒ `unavailable:provider_missing` (retried once after 24 h). |

## `catalog-sync` (existing, changed)

- Walks every `active` selection (root first) instead of only the root.
- Sets `folder_indexed_at` on the last page of a folder; emits `folder_indexed`.
- Change replay: root id change ⇒ `service_mark_root_state`; a changed image/video/landing
  ⇒ `thumbnail_state = 'pending'`.
- Never enters `.soty` (unchanged).

## Agent (`apps/agent`, team-bridge)

No new HTTP routes. `TeamLandingRenderBridge` gains `runBackgroundLoop({ governor, drain })`:
claims one render at a time via `landing_render_start` when the paired space reports pending
renders, honours the power lever (renders only at the governor's allowed concurrency, never
more than one), stops on drain/shutdown, and reports `backgroundRender: true` in the
`teamWorkspace` tool contract so old agents are never asked.
