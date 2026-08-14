# Contract: Process Library, Distributed Jobs & Transcript Sidecars

## Scan without starting work

`POST /functions/v1/library-ops/process/scan`

Body: `{ teamId, interfaceLanguage }`.

- Guard: current `process`; active Library visibility.
- Paged scan upserts version-bound requirements for missing original transcription,
  interface-language translation (unless equal to original), and supported landing
  optimization.
- Existing current results for the same source version/kind/variant are excluded. Stale,
  failed or canceled needs are counted separately.
- Response is counts/cursors only; it does not claim a lease, issue a transfer grant or
  start the agent.

Repeated scans over unchanged data are idempotent.

## Claim and heartbeat

`POST /functions/v1/library-ops/process/claim`

Body: `{ teamId, agentInstanceId, supportedKinds, interfaceLanguage }`.

- Guard: caller `process`, current compatible `teamWorkspace` contract and active agent.
- Atomically marks one pending/failed/reclaimable requirement leased and creates an attempt.
- Returns exact source/version/kind/variant, opaque attempt/lease token, scoped input/output
  grants and expiry. No Google id/token/path is present.
- Claims lock only one requirement. Other agents may claim other operations for the asset.

`POST /functions/v1/library-ops/process/heartbeat` compares actor, agent, attempt and hashed
lease token; it may update safe stage/progress and extends expiry to at most the configured
lease window. Pause/cancel/shutdown explicitly stops renewal. An expired attempt cannot be
revived; the requirement becomes reclaimable.

## Agent delegation and result acceptance

The web delegates a claimed job to `POST /api/team/library/process` through existing
session/entitlement headers. The agent:

1. validates the job and lease envelope;
2. downloads bounded ranges into a fresh temp directory;
3. invokes the existing transcription/translation/landing pipeline;
4. sends heartbeats/progress through the single team SSE path;
5. uploads a candidate to the reserved destination;
6. asks cloud finalize to verify and accept it;
7. removes all temporary data in `finally`.

Finalize locks the requirement and rechecks current source version, permission, lease and
that the result is still missing. The first valid candidate becomes current. A late candidate
returns `{ state:'skipped', reason:'already_completed' }`, does not overwrite the current
material and is reconciled as a non-current artifact.

## Transcript and translation artifact contract

- Original transcription is a deterministic UTF-8 text sidecar adjacent to the source and
  unique for `(video,sourceVersion,original)`.
- Translation is a distinct UTF-8 sidecar unique for target BCP47 variant; identical
  source/interface language reuses original without a duplicate artifact.
- Both are catalog materials with provenance and a version-bound result row. Their bounded
  transcript cache follows feature 001 ingestion rules.
- A source content change marks prior variants stale; a pure move keeps them current.

### `list_video_text_variants(p_team,p_video)`

Caller-checked `view` RPC returns only current variants:

`{ sourceVersion, variants:[{ materialId, kind:'original'|'translation', language,
ingestState, truncated, text, updatedAt }], canProcess }`.

This is the only video-card body-bearing read. It applies exact team/source/version
predicates. Text never enters a list row, Realtime, analytics, contribution, audit or logs.
The web behavior is structural:

- current cached text → View Text; after a displayed variant is selected → Copy Text;
- missing/stale/no current variant → Transcribe; Copy absent;
- View/Copy never call scan/claim/start.

## Group move/trash/restore

Source video operations resolve the current transcript + translation result materials before
the first Drive mutation. One idempotent intent snapshots the group.

- move: every member moves to the same canonical destination group;
- trash: Drive recoverable trash is applied to sidecars and source;
- restore: every member is restored to a verified allowed destination;
- rename is source-only unless a later naming policy explicitly requests sidecar rename.

Success requires post-verification for every member and one catalog commit. A partial provider
failure is `reconciling`; safe compensation is attempted, sync can resume the intent, and UI
shows neither old nor new state as fully successful until convergence.

## Terminal states and errors

Requirement: `pending|leased|running|ready|failed|canceled|stale|skipped`.
Attempt: `leased|running|ready|failed|canceled|expired|skipped`.

Stable errors include `NO_WORK`, `LEASE_EXPIRED`, `LEASE_MISMATCH`, `ALREADY_COMPLETED`,
`STALE_RESULT`, `SOURCE_CHANGED`, `AGENT_REQUIRED`, `AGENT_UPDATE_REQUIRED`,
`PERMISSION_DENIED`, `GROUP_RECONCILING`, and existing typed tool/Drive errors.
