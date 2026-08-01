# Contract: Preview & Local Processing Bridge

Covers FR-038…FR-044. Preview/processing never gives the browser or agent a Google token;
the server grants one material/purpose/operation at a time. The agent bridge is negotiated
through the `teamWorkspace` tool contract so old agents fail with an update-required state.

## Preview session

### `POST /functions/v1/drive-transfer/preview`

**Body**: `{ teamId, materialId, mode }`, where
`mode = media | transcript | archive | landing`.

- **Guard**: JWT + `view`; live material/team/root checks.
- **Returns** one discriminated result:
  - `{ kind:'media', rangeUrl, mimeType, expiresAt }`;
  - `{ kind:'transcript', text, ingestState, truncated, indexedBytes, sourceVersion,
allowedActions }` from a caller-checked permission-filtered catalog RPC;
  - `{ kind:'agent', operationId, transferGrant, previewKind:'archive'|'landing' }`;
  - `{ kind:'unavailable', reason:'unsupported'|'corrupt'|'protected'|'too_large'|
 'agent_required', allowedActions }`.
- No provider link/token/error is returned. Preview failure uses a real typed state, never a
  placeholder that looks complete.

### Native media

`<video>/<img>` consumes the no-referrer, no-store, short-lived Range URL from
`drive-transfer`. Each request is ≤32 MiB and rechecks current permission. A full download
button is separately guarded by `download`; inline view does not return attachment
disposition or a reusable Google URL.

### Transcript

Uses indexed catalog transcript text with explicit `full|truncated|invalid_encoding|
unavailable` state and an “open/download full” action when allowed. SRT/VTT are rendered as
sanitized extracted cue text, never HTML. Only complete valid UTF-8 `.txt` ≤1 MiB exposes
the separate editor action when caller has `edit`. It never publishes transcript text through
Realtime, analytics, audit, or logs.

### Archive listing (`POST /api/team/preview/archive` on agent)

- Existing local session/entitlement + scoped agent transfer grant.
- Agent downloads bounded ranges into `mkdtemp`, uses the existing archive scanner limits
  (path traversal, compression ratio, 5 GiB total uncompressed, 2 GiB single entry), and
  returns only a typed entry manifest. It never extracts to team Drive.
- Password-protected/corrupt/over-limit maps to the unavailable result; temp files are
  removed in `finally`.

### Navigable landing preview (`POST /api/team/preview/landing` on agent)

- Reuses existing archive validation/extraction, local server, Playwright safety work and
  screenshot renderer, but does not pretend the current screenshot gallery is interactive.
- The new team preview is served from a dedicated random local preview origin and embedded
  in an iframe sandbox with scripts only: no same-origin, forms, popups, top navigation or
  downloads. CSP blocks `connect-src`, form submission and object embedding; local package
  assets are path-confined. The preview receives no Wishly/session/team data.
- Internal links can navigate within the extracted package. External navigation/actions are
  blocked and surfaced as a warning. Screenshot segments are the safe fallback.
- A successful scanner result returns a source-version/fingerprint-bound validation record;
  cloud finalization promotes category `archive → landing` only if the material identity still
  matches. Any later Drive version change clears the promotion before revalidation.
- Closing/canceling removes extracted content and terminates the preview server/context.

## Begin processing (cloud authority)

### `POST /functions/v1/drive-ops/process/start`

**Body**: `{ teamId, materialId, toolId, optionsSummary, destinationFolderId,
outputName, conflictMode, idempotencyKey }`.

- **Guard**: JWT + `process`; active agent contract compatible; live source ancestry/read
  capability and destination ancestry/add capability; tool supports category; visible
  limits accepted; explicit name-conflict choice.
- Creates/reuses one operation and name reservation.
- Issues short-lived hashed grants bound to actor/team/source/tool/destination/operation:
  repeated bounded source ranges plus one agent-finalization capability. Raw processing
  options are still validated by the agent's existing tool parser.
- **Returns** `202 { operationId, sourceGrant, finalizeGrant, agentContractVersion }`.

The existing general entitlement token proves product access only; it is never accepted as
team/material authorization.

## Agent bridge

### `POST /api/team/process`

**Body**: `{ operationId, toolId, options, sourceGrant, finalizeGrant }` plus existing agent
session/entitlement headers.

1. Verify teamWorkspace contract and parse all input.
2. Download source via repeated bounded Range calls to a new temp directory. Every new
   range lets cloud authority re-check membership/permission.
3. Invoke the existing compressor/transcription/landing/media pipeline and publish typed
   progress over the agent's team SSE channel. Existing cancel/watchdog/spawn rules apply.
4. Request a destination-bound Google resumable session with `finalizeGrant`; server
   re-checks the actor before starting this new side effect.
5. Upload output directly in resumable chunks; pass returned exact Drive file id to cloud
   finalize.
6. Finalize verifies Drive parent/name/size, upserts result, inherits GEO/offer/language/
   tags, creates `processed_from`, appends audit, marks succeeded.
7. Always remove source/output temp copies in `finally`.

Source is never overwritten by this route. Explicit replacement is a separate guarded Drive
operation requiring `upload+edit` and confirmation.

### `POST /api/team/process/{operationId}/cancel`

Cancels the running local tool where supported, stops requesting new transfer ranges, removes
temp files, and uses the scoped completion path to mark `canceled`. If a Google upload
already completed, finalize reconciles/tombstones the orphan rather than claiming cancel
silently removed it.

## Retry, idempotency, and state

- Same `(team, actor, process, idempotencyKey)` returns the existing operation/result.
- Retry after `failed` creates an explicit new attempt linked to the prior operation, unless
  Drive verification finds an already-successful result for the original operation.
- States: `pending → running → succeeded|canceled|failed`; stage identifies
  `downloading|processing|uploading|finalizing` and never marks partial output succeeded.
- Initiating UI receives fine-grained local progress by Fastify SSE. Authoritative operation
  state/result is Postgres and reaches team UI through RLS-filtered Realtime + refetch.
- Membership/permission changes block the next range/session/finalize. An already-issued
  resumable upload is the explicitly allowed in-flight operation and may safely finish, but
  cannot create another result or finalize under a different destination.

## Error mapping

`UNSUPPORTED_MEDIA` (415), `CORRUPT_OR_PROTECTED` (422), `AGENT_REQUIRED` (409),
`AGENT_UPDATE_REQUIRED` (409), `TOO_LARGE` (413), `PERMISSION_DENIED`/`ROOT_ESCAPE`
(403), `NAME_CONFLICT` (409), `DRIVE_UNAVAILABLE`/`NEEDS_REAUTH` (503), and typed existing
tool errors. Provider/human text is logged safely server-side and never becomes the machine
code.

## Guarantees

- Team HTML cannot read account/team/session data or act as the user.
- Archive preview never extracts into Drive; no fake preview exists for unreadable content.
- Google credentials stay server-side; agent gets only scoped, revocable operation grants.
- Original bytes survive processing; one verified derivative/result is idempotently linked.
- Progress, cancellation and terminal state remain observable across reconnect/reload.
