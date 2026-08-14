# Phase 0 Research: Team Space / Creative Library

All planning unknowns are resolved. This increment inherits the security, Google Drive,
bounded transfer, catalog, preview, and local-agent decisions from feature 001 and the cached
landing-render decisions from feature 004. The decisions below cover only new behavior.

## R1. Stable asset identity versus physical Creative Library placement

**Decision.** Keep `team_materials.id` and Drive `drive_file_id` as stable asset identity.
Store Stage/Offer/Language/Type as explicit structural placement metadata and resolve each
canonical Drive folder server-side. A structural change is a Drive move saga followed by a
verified catalog commit; it never creates a replacement logical asset.

**Rationale.** Tasks, results, audit and cached previews must survive moves. A path string is
mutable and cannot be authority; the stable catalog/Drive ids already exist.

**Alternatives considered.** A virtual folder hierarchy would contradict the specification.
Copy-then-delete creates duplicate windows and breaks identity. Deriving structure only from
folder names cannot distinguish normalized collisions or external moves safely.

## R2. Bulk upload is a batch of independent idempotent item operations

**Decision.** A batch row stores shared requested metadata and aggregate counters. Each file
gets its own existing resumable upload operation/idempotency key, outcome and reconciliation
state. The browser runs bounded concurrency and exposes per-item progress; a completed item
is visible immediately without waiting for the batch terminal state.

**Rationale.** Google resumable sessions and existing file operations are already item-scoped.
One huge transaction would make partial success unrecoverable and would violate truthful
progress.

**Alternatives considered.** One multipart Edge request would exceed worker bounds. A single
all-or-nothing batch is impossible across Drive and Postgres. One form per file defeats the
user journey.

## R3. Canonical folder creation and name normalization

**Decision.** Normalize every structural segment to a bounded display value and a stable
case-folded key. A server-side mapping table binds `(team, parent, segment kind, normalized
value)` to one verified Drive folder id. Unknown is an explicit controlled value. Folder
ensure/move uses a team-scoped lock, live ancestry/capabilities and existing name-conflict
rules.

**Rationale.** Drive allows duplicate folder names. A database mapping plus verification is
required to avoid two physical destinations for the same logical placement.

**Alternatives considered.** Blind `files.list` by name races and permits duplicates. Adding
GEO as a path level contradicts the four-segment scope.

## R4. Manual-first local language detection

**Decision.** Store a language decision source and source-version token. Manual batch or
later edits increment a decision revision and cancel/fence automatic work. Landing detection
uses readable local DOM/text heuristics. Video detection samples a bounded 5–8 second speech
window, then one later window if needed, through existing FFmpeg/whisper machinery. Results
below the documented confidence threshold become `unknown`; a late result commits only if
the source version and decision revision still match.

**Rationale.** This gives manual input absolute priority, avoids full transcription during
upload and makes races testable.

**Alternatives considered.** Filename/attribute guesses are unreliable. Full transcription
on upload violates the explicit-start rule. A remote generative classifier violates the
local-data boundary.

## R5. Lightweight enrichment stays separate from heavy processing

**Decision.** After upload, enqueue small version-bound enrichment records for metadata,
language and thumbnail/landing preview. Heavy transcription, translation and optimization
become separate processing requirements only when the user explicitly scans/starts Process
Library or starts the per-video transcription action.

**Rationale.** Assets must become visible before enrichment finishes, while user machines
must not receive surprise heavy work.

**Alternatives considered.** One generic queue would make a thumbnail indistinguishable from
a multi-minute transcription and weaken consent/status semantics.

## R6. Processing requirement, attempt and accepted result are distinct

**Decision.** A version-bound requirement is unique by team, source material, source version,
operation kind and normalized variant. Attempts carry lease owner/expiry, heartbeat,
progress and terminal outcome. Accepted results are a separate first-writer-wins record with
one current artifact; source-version changes mark the prior requirement/result stale rather
than deleting history.

**Rationale.** One operation may have several attempts after crashes or races. Conflating the
need, attempt and result either blocks recovery or permits duplicate ready artifacts.

**Alternatives considered.** A user/asset lock prevents unrelated operations from running in
parallel. An in-memory agent queue cannot coordinate teammates. Last-writer-wins could
overwrite a valid shared result.

## R7. Distributed work is claimed by authenticated users and delegated to their agent

**Decision.** The web calls a caller-scoped claim endpoint, which rechecks `process`, binds
one pending/reclaimable requirement to an opaque agent instance and issues scoped transfer/
finalize grants. The existing local agent receives only the claimed job and grants. Heartbeat
renews that one lease; pause/cancel/shutdown stops renewal. A database compare-and-set accepts
the first still-needed valid result and reports later completions as `skipped`.

**Rationale.** The local agent has no Google credential and an entitlement token is not team
authorization. User JWT + scoped grants preserve the established trust boundary.

**Alternatives considered.** Giving the agent a service key or shared Drive token is too
powerful. Browser-only in-memory coordination cannot survive disconnects or multiple users.

## R8. Transcript and translation files are current sidecars of a video version

**Decision.** Accepted transcription/translation results create ordinary catalog materials
plus a version-bound processing-result record and provenance link. At most one current
original transcript exists per source version; translations are unique per target language.
The cached text remains in the sidecar material's bounded transcript index. Video cards query
a caller-checked closed projection of current variants; View/Copy read that cache and never
start processing.

**Rationale.** A Drive text document satisfies portability, while the bounded catalog cache
supports immediate shared view/copy. Version identity prevents stale text from looking
current.

**Alternatives considered.** Storing text only in Postgres would not create the requested
document. Searching by filenames cannot prove provenance or source version. Auto-starting on
View surprises users and duplicates work.

## R9. Sidecar move/trash/restore is a truthful group saga

**Decision.** Before a source move/trash/restore, the server resolves all current sidecars,
proves live ancestry/capabilities for every member and creates one group operation. It applies
Drive mutations deterministically, verifies all members, then commits catalog state. On a
partial provider failure it attempts safe compensation when possible, records `reconciling`,
and never returns success until every member converges. Sync/reconciliation can finish the
same idempotent intent.

**Rationale.** Drive offers no multi-file transaction. A documented saga is the only way to
honor logical grouping without claiming impossible atomicity.

**Alternatives considered.** Moving only the source violates the scope. Deleting database
rows hides provider inconsistency. Permanent delete removes recovery options.

## R10. Tasks are relational references, not a file system

**Decision.** `team_tasks` stores title/note, one nullable active assignee, status and
progress. `team_task_attachments` is a unique `(task, material)` join with ordering and
attach metadata. Material rows are tombstoned rather than deleted, so an attachment survives
move/rename and shows a typed unavailable state after trash/lost access. Task reads require
`view`; mutations and attachments require `edit` and exact same-team visibility.

**Rationale.** References meet the no-move/no-copy requirement and keep tasks lightweight.
The existing permission model avoids inventing a ninth permission mid-feature.

**Alternatives considered.** Copying files into task folders violates Drive identity.
Embedding material snapshots becomes stale and leaks deleted metadata. A JSON array weakens
dedupe, paging and RLS.

## R11. Unlimited attachment semantics use paged reads and bounded writes

**Decision.** Do not define a product-level attachment maximum. The UI may send repeated
bounded mutation batches (for example 100 ids/request) and reads attachments in pages. Each
id is independently authorized and upserted; duplicates are idempotent, while rejected ids
are returned separately without rolling back valid attachments.

**Rationale.** Network/request limits are operational, not a user-visible semantic cap.

**Alternatives considered.** One unbounded request risks memory/statement limits. A fixed
task cap contradicts the user requirement.

## R12. Task date filters use explicit UTC bounds derived from local calendar dates

**Decision.** The browser converts the chosen local day into `[from,to)` UTC timestamps and
passes those bounds to a caller-checked list RPC. Today/Yesterday use the same local zone;
All Time passes no bounds. The active filter is visible and does not mutate tasks.

**Rationale.** Postgres cannot infer the viewing user's timezone safely. Explicit bounds make
DST and midnight behavior deterministic and testable.

**Alternatives considered.** Server UTC dates surprise users outside UTC. Persisting a team
timezone was not requested and adds administration.

## R13. Attachment thumbnails reuse authorized preview surfaces

**Decision.** Image/static tiles use short-lived scoped media previews. Landing tiles reuse
the current cached render artifact and typed fallback. Video tiles render a muted,
controls-free preview, wait for metadata, seek to exactly 1.0 seconds (or the last seekable
instant for shorter media), and expose ready only after `seeked`; frame zero is never treated
as the target frame. Drag has keyboard/search parity.

**Rationale.** Reusing preview authority avoids a second blob cache and keeps permissions
current. The HTML media element can display the requested frame without a new image service.

**Alternatives considered.** A generic file icon does not meet the preview requirement.
Generating every frame in Edge is unbounded. Canvas capture can fail under cross-origin
rules and is unnecessary when the paused video itself is the tile.

## R14. Create-from-asset and multi-drag are explicit, validated actions

**Decision.** Every supported asset card exposes a visible keyboard-accessible Create Task
button; right-click may be an enhancement but is not required. Tree rows use a shared typed
drag payload containing only same-session material ids. Drop validates each id through the
same attach RPC used by search. The created task opens immediately.

**Rationale.** A visible action is discoverable and accessible, while sharing one mutation
path prevents drag from bypassing authorization.

**Alternatives considered.** Context-menu-only creation is inaccessible on touch/keyboard.
Trusting browser drag metadata would let a forged payload reference a hidden team.

## R15. Quick Share stores intent, not authority

**Decision.** Copy Link first fetches current Drive permission/capability and exact
`webViewLink`. Existing public links copy directly. Restricted assets require an explicit
prompt unless a user+team preference says the user previously approved; either path still
requires Soty `edit`, live `canShare`, exact-item ancestry and a fresh provider update. The
preference is resettable and never bulk-applies to a folder/Library.

**Rationale.** Remembering a prompt choice improves speed without becoming a permission
grant.

**Alternatives considered.** Constructed Drive URLs may be wrong for some resource kinds.
Automatic Library-wide sharing violates least privilege. Browser-only preference cannot be
authoritatively scoped across sessions/devices.

## R16. Contribution records are allowlisted and separate by meaning

**Decision.** Store immutable, content-free contribution rows with category
`local_processing|human_activity`, actor, optional opaque agent instance, action kind,
outcome and time. Producers call service functions with closed enums; triggers/RPCs reject
payloads containing filenames, content, paths, URLs, ids from providers, or arbitrary JSON.
No combined score or leaderboard is computed in this increment.

**Rationale.** Correct semantics must exist before a future Busy Bees UI, and privacy is
stronger when forbidden data has no storage column.

**Alternatives considered.** Reusing generic analytics loses audit-grade actor/team meaning.
Free-form JSON risks accidental content capture. A single score conflates machine capacity
with human work.
