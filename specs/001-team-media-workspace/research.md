# Phase 0 Research: Командний медіапростір Wishly

All specification clarifications and technical unknowns are resolved. No
`NEEDS CLARIFICATION` marker remains. Decisions below are the basis for `plan.md` and the
Phase 1 artifacts.

## R1. Drive OAuth scope and folder selection

**Decision.** Use one server-held OAuth connection per team and request the restricted
`https://www.googleapis.com/auth/drive` scope. The owner selects the root through a
server-proxied folder browser; Wishly never gives the broad access token to browser Picker.
Production launch is gated on Google's restricted-scope verification/security assessment.
The closed deployment setting is `DRIVE_OAUTH_MODE=disabled|testing|verified`, defaults to
`disabled`, allows `testing` only on a non-production origin, and allows production OAuth
start only as `verified`; every rejected start returns `OAUTH_APPROVAL_REQUIRED`.

**Rationale.** Google's `drive.file` scope is broader than the old plan claimed: it can
access files/folders the user opens or explicitly shares with the app and is recommended
with Picker. Its authorization is nevertheless per selected file resource. Google does not
document selecting one folder as recursively granting the app all pre-existing descendant
resources. Because FR-018/020 require arbitrary existing descendants and read/write/trash,
the plan cannot treat `drive.file` as a recursive folder boundary. This is an inference from
Google's per-file definition and is covered by an OAuth integration test. The restricted
scope is operationally heavier but matches the clarified shared-connection requirement.

Sources: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Google Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker),
[restricted-scope assessment](https://support.google.com/cloud/answer/13465431?hl=en).

**Alternatives considered.** `drive.file` + Picker was rejected for the complete subtree;
per-member OAuth was rejected by clarification; Google Shared Drives-only was rejected
because My Drive folders must work.

## R2. OAuth transaction and refresh-token custody

**Decision.** `drive-connect` creates a short-lived server-side OAuth transaction containing
a high-entropy state hash, owner/team binding, PKCE verifier reference, expiry, and consumed
flag. The Google callback is public (`verify_jwt=false`) but can act only after atomically
consuming that transaction. Authorization requests offline access; a later response that
omits a refresh token never erases the stored token. A refresh token is stored with
`vault.create_secret`; the public connection row stores no credential field. Detach deletes
the Vault secret when its final reference is gone; reauth updates it. `invalid_grant`,
revocation, time-limited/testing grants and provider inactivity move connections to
`needs_reauth`. The callback redirects to the Wishly web origin and never returns HTML
content itself.

**Rationale.** Google redirects do not carry the user's Supabase JWT. Supabase Vault is
designed for dynamic encrypted secrets and keeps its root key outside the database, while
`vault.decrypted_secrets` must remain inaccessible to client roles. Edge project secrets
are configuration, not a per-team store (and have a project count limit).

Sources: [Supabase Vault](https://supabase.com/docs/guides/database/vault),
[Edge Function limits](https://supabase.com/docs/guides/functions/limits).

**Alternatives considered.** Per-team Edge environment secrets do not scale; custom AES-GCM
envelope encryption is viable but adds key rotation and cryptographic implementation that
Vault already supplies; browser/local-agent token custody violates least privilege.

## R3. Authorization modes and database boundary

**Decision.** Use three explicit auth modes:

1. user endpoints require a valid Supabase JWT and authorize through a user-scoped client,
   so `auth.uid()` and RLS are authoritative;
2. the OAuth callback uses only its one-time transaction;
3. `catalog-sync` accepts only a named server secret and consumes a durable queue.

A service-role client is created only after a caller-scoped authorization gate and is
limited to Vault and internal completion RPCs. In accordance with the project constitution,
every feature SQL function—including reads/search, actions, policy/trigger helpers, and
service-only functions—is `security definer`, sets `search_path=''`, and schema-qualifies
every object. Caller-facing functions derive identity only from `auth.uid()`, reject a null,
inactive, removed, or foreign-team caller, apply explicit team/permission predicates before
reading sensitive rows, and never trust a caller-supplied actor. Creation revokes default
execute and regrants only `authenticated` for named user RPCs or `service_role` for backend
functions. RLS and narrow column grants remain defense in depth, but definer reads never
rely on RLS as their authorization proof and no owner-created view becomes a shortcut.

**Rationale.** A service-role client bypasses RLS; using it for the initial user decision
would turn an application check into the only security boundary. Definer reads likewise
require closed output shapes and explicit caller/team predicates. An inventory pgTAP test
checks `prosecdef`, empty `search_path`, exact EXECUTE ACL, spoofed actor/foreign-team/null
caller behavior, and search-path shadowing for every new function.

Sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[PostgreSQL 17 `CREATE FUNCTION`](https://www.postgresql.org/docs/17/sql-createfunction.html).

**Alternatives considered.** “Every Edge Function has a JWT” cannot cover Google callbacks
or cron. Invoker-mode read RPCs would normally reduce bypass surface but conflict with
the literal repository constitution; explicit caller-checked definers satisfy that governing
constraint without widening table grants.

## R4. Large-file transport

**Decision.** Edge Functions are the authorization/control plane, never a full-file buffer.

- Upload: Edge re-checks permissions, live destination ancestry/capability, conflict mode,
  and idempotency; it then initiates a Google resumable upload and returns the scoped session
  URI. Browser/agent sends 256 KiB-aligned chunks directly and calls finalize; finalize
  verifies the Drive file before catalog success.
- Download/preview: `drive-transfer` exchanges a hashed, scoped grant for at most a 32 MiB
  `files.get?alt=media` Range and forwards 206/`Content-Range`. Browser-only full download
  is capped at 100 MiB; larger downloads and processing are assembled by the local agent
  over repeated bounded ranges.
- Google-native documents, whose export path does not support Range, are visible as
  `other` but not full-file preview/processing in v1.

**Rationale.** Supabase Edge workers have 256 MB memory, 2 s CPU, 150/400 s wall-clock and
a 150 s idle limit. Streaming controls memory but not wall time. Google recommends resumable
uploads for most files and limits multipart guidance to small files. Private Drive blobs
download through authenticated `alt=media`; there is no Wishly-member-safe Google presigned
download URL, while byte ranges are supported.

Sources: [Edge limits](https://supabase.com/docs/guides/functions/limits),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

**Alternatives considered.** One Edge multipart proxy cannot satisfy large media/retry;
passing the Google token to agent/browser exposes account-wide authority; a separate
streaming service is deferred because bounded Range transfer uses current infrastructure.

## R5. Root confinement, capabilities, and shortcuts

**Decision.** Before every Drive side effect, fetch current item/destination metadata and
capabilities, then walk real `parents` to the connected root (bounded by Drive's hierarchy
limit). Catalog `parent_folder_id` and cached capabilities are UI/search data only. Root
itself cannot be moved/renamed/trashed. A shortcut is catalogued as a shortcut; v1 never
dereferences its target unless the target independently passes the same ancestry proof.
All Shared Drive calls set `supportsAllDrives=true` and preserve `drive_id/resourceKey`.

**Rationale.** Drive capabilities are per item and differ between My Drive/Shared Drives;
folder queries are not a recursive security boundary. Shortcuts can target outside the
root. Live ancestry + capability is therefore the external half of FR-020/021.

Sources: [Drive capabilities](https://developers.google.com/workspace/drive/api/guides/manage-sharing),
[shortcuts](https://developers.google.com/workspace/drive/api/guides/shortcuts).

**Alternatives considered.** String path checks, cached parents, and connection-wide
`can_write` flags are stale/insufficient.

## R6. Durable catalog synchronization

**Decision.** One Supabase Cron schedule invokes a named-secret `catalog-sync` worker. A
durable queue stores connection, phase, cursor/page token, lease, attempts, and retry time.
Initial sync records a change token, breadth-first scans the root in bounded pages, then
replays changes from that token. Incremental sync consumes the user change log for My Drive
or drive-specific log for a Shared Drive and independently revalidates root ancestry.
Upserts are idempotent on `(team_id, drive_file_id)`; removals/moves create tombstones rather
than deleting provenance. Sync and upload finalization invoke the same shared category
classifier. For transcript candidates, a bounded Range fetch accepts an optional UTF-8 BOM,
keeps at most the first 1 MiB on a valid code-point boundary, records full/truncated/invalid/
unavailable status plus the source Drive version/checksum, and replaces or clears indexed
text when that source identity changes or becomes a tombstone. 429/5xx retry with backoff;
a full reconciliation is resumable.

**Rationale.** The Drive changes feed is user/drive-wide, not root-filtered, and a 50,000
item scan cannot live in one Edge invocation. Cron + durable queue/checkpointing survives
timeouts and concurrent workers.

Sources: [Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes),
[Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Supabase Queues](https://supabase.com/docs/guides/queues).

**Alternatives considered.** Live `files.list` per catalog query misses custom facets;
one `waitUntil()` job is not durable; per-team cron does not scale.

## R7. Ownership, membership, and effective permissions

**Decision.** `teams.owner_id` is the single owner identity. `team_members.base_role` stores
only `admin|editor|viewer`; public `Role='owner'` is computed when `user_id=owner_id`.
`owner_id` is non-null and a deferred invariant verifies a matching active membership at
transaction end. Create/transfer/remove/account-delete paths are RPC-only. Transfer updates
the pointer atomically, writes the old owner's explicit demotion role, and audits. Account
deletion returns `OWNERSHIP_TRANSFER_REQUIRED` while any team is owned.

Role defaults + boolean overrides produce effective permissions. `can()` also requires an
active membership and `profiles.account_status='active'`; unknown flags are false.

**Rationale.** A partial unique owner-role index proves at most one owner, not at least one,
and duplicating owner in two mutable columns invites drift. One non-null owner pointer plus
an active-membership invariant proves exactly one.

**Alternatives considered.** Application owner counts and a partial unique index are
race-prone/incomplete; direct membership/table writes are too broad.

## R8. Search, controlled vocabularies, and shared contract

**Decision.** Postgres holds the permission-filtered catalog. Facets use btree indexes;
search uses a `simple`-configuration generated `tsvector` over normalized name, tags, GEO,
offer, language, and allowed transcript text, plus explicit normalized facet predicates.
Offer options are distinct normalized values for the current team; missing facets have
partial indexes.

GEO uses ISO 3166-1 alpha-2 codes; language uses a committed BCP 47 allowlist. Offer/tags
are Unicode-NFC, trimmed free text and deduplicated case-insensitively within one material.
Shared TypeScript constants are canonical. `generate:team-contract` is exactly
`npm run build -w @video-compressor/shared && node scripts/generate-team-contract-sql.mjs`,
so no consumer can observe stale committed `dist`. The deterministic generator snapshots
role defaults, permission flags, invite TTL, vocab, category/editor rules, limits, and a
contract version into migration SQL; pgTAP/TypeScript parity tests prevent drift. A
process-level temporary workspace makes shared source newer than stale `dist` and proves
`generate:team-contract -- --check` rebuilds then detects drift before normal generation
converges. The package root re-exports the contract.

**Rationale.** `simple` avoids applying one language stemmer to multilingual content.
Generated lookup rows let SQL enforce values without hand-maintained duplicates.

**Alternatives considered.** External search adds infrastructure unnecessary for 50,000
rows; duplicated handwritten TS/SQL constants violate the constitution.

## R9. Preview isolation

**Decision.** Preview paths differ by format:

- video/image: scoped Range stream (inline disposition);
- transcript: caller-checked, permission-filtered catalog text with explicit truncation/
  encoding status and full-download fallback;
- archive: local agent downloads to a temp directory and returns a bounded entry manifest;
- landing/package: extend the existing archive scanner/local server into a dedicated random
  preview origin and sandboxed iframe (`allow-scripts`, no same-origin/forms/popups/top-nav/
  downloads) with CSP blocking connections and a screenshot fallback.

Unsupported, corrupt, protected, or over-limit items return a typed reason and allowed
actions. The existing screenshot renderer is reused as a component/fallback, not falsely
described as an already-navigable HTML sandbox.

**Rationale.** Supabase rewrites HTML without a custom domain and is not the safe landing
runtime. A dedicated local origin plus opaque iframe origin prevents team HTML from reading
Wishly account/team data or calling authenticated APIs.

**Alternatives considered.** Public Drive links violate FR-016; rendering untrusted HTML on
the Wishly origin is unsafe; screenshot-only does not satisfy the navigable acceptance case.

## R10. Local processing bridge and live state

**Decision.** `begin-process` validates actor/team/material/tool/destination and creates an
idempotent operation plus hashed, short-lived transfer grants. The agent receives only the
operation/grants alongside its existing session + entitlement tokens. It downloads bounded
ranges, runs the existing tool, obtains a destination-bound resumable session, uploads, and
finalizes. Each new transfer/finalize re-checks current membership/permission; an already
started upload may safely complete as the spec's in-flight exception. Source is never
overwritten implicitly and metadata/provenance are committed only after Drive verification.

Local tool progress remains Fastify SSE. Cloud `operations`/catalog changes use
RLS-filtered Supabase Postgres Changes with reconnect refetch; progress writes are
throttled. Neither channel polls or pretends to be the other.

**Rationale.** Existing entitlement proves product access, not team/material authority.
Scoped grants close that trust gap, while keeping Google credentials off the device.

Source: [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).

**Alternatives considered.** A web-only precheck is forgeable/stale; cloud state cannot be
published through an unrelated local agent SSE channel; Edge-hosted long-lived SSE hits
worker wall-clock limits.

## R11. Invitations, expiry, capacity, and email

**Decision.** Resolve every target to a canonical confirmed `citext` email; account invites
also retain `target_user_id`. A single partial unique key on `(team_id, target_email)` blocks
email/account cross-form duplicate pending invites. Acceptance is an atomic RPC checking
confirmed identity, 14-day expiry, active-membership dedupe, and the 50-member cap under a
team lock. Email deep links also check their token hash; authenticated in-app invites accept
by id without exposing token plaintext. A scheduled sweep materializes `expired`, but accept
always checks `expires_at`.

`team-invitations` sends via Resend with a verified domain. Creation succeeds independently
of delivery; `delivery_state` exposes pending/sent/failed and resend rotates token/expiry.
In-app `list_my_invitations()` covers delivery failure and existing accounts.

**Rationale.** Supabase Auth invite APIs do not model Wishly team membership and do not
cover both existing/new accounts. Resend is the documented existing Edge pattern, while the
database remains authoritative if email is temporarily unavailable.

Source: [Supabase Edge email example](https://supabase.com/docs/guides/functions/examples/send-emails).

**Alternatives considered.** Cron-only expiry races acceptance; separate email/user unique
indexes allow cross-form duplicates; unverified-email acceptance violates FR-005.

## R12. Cross-system consistency, analytics, and compatibility

**Decision.** Every Drive write is a small saga: create an idempotent operation, perform the
external action, verify Drive state, update/tombstone catalog, append audit, then publish
success. Retries reuse the same idempotency key; sync reconciles “Drive succeeded / DB
finalize failed”. `request_nonce` is a real operation field, and source rows are tombstoned
so provenance survives delete/move/lost access.

Typed analytics events measure onboarding duration, search/find time, preview, file action,
processing completion, and weekly team activation without file names/content. The existing
read-only analytics path gains aggregate team metrics for SC-001/005/009; SC-008 remains a
moderated pilot usability measure. SC-001/005/008 each use 20 first-time/pilot participants
and require 18 successes. SC-004 uses three runs of 20 warmups + 200 measured authenticated
application calls over a deterministic 50k fixture; each run's p95 must be <2 s, while SQL
plans are diagnostics only. SC-006 uses 100 preview starts at ≥50 Mbps/≤50 ms RTT. SC-007
uses 100 actions, 20 per operation family, and requires zero loss, silent overwrite, or false
success. SC-009 uses four separate team-relative seven-day windows. A denominator team-week
requires pilot enrollment, a non-detached root, at least two active members at window start,
and at least one authenticated workspace session in that window; each week independently
needs a 70% numerator with both discovery and production, and an empty denominator is
insufficient evidence rather than a pass.

The `team-bridge` is a new agent protocol surface, so `release.ts` gains a
`teamWorkspace` tool-contract version and compatibility requirement. Old agents show an
update-required state; `AGENT_API_VERSION` changes only for an actually incompatible core
protocol change.

**Rationale.** Drive and Postgres cannot share a transaction; explicit operation state,
verification, and reconciliation prevent partial work from appearing complete. Success
criteria are not verifiable without instrumentation. Protocol compatibility must remain in
the release contract's existing source of truth.

**Alternatives considered.** Best-effort dual writes lose state; nullable provenance without
tombstones loses history; shipping a new route without contract negotiation breaks older
agents silently.

## R13. Material classification, transcript editing, and version semantics

**Decision.** `packages/shared/src/team/material-category.ts` owns a versioned pure
classifier used at initial sync, incremental sync, upload finalize, edit finalize, and
reconciliation. Folders have no material category. Explicit `video/*` and `image/*` MIME
types win; explicit HTML/XHTML is `landing`; explicit VTT/SubRip/plain-text is `transcript`;
known archive MIME is `archive`. When MIME is missing, generic, or unrecognized, normalized
extension falls back to video/image, `.html|.htm`, `.txt|.srt|.vtt`, or known archive sets;
otherwise category is `other`. A zip begins as `archive` and may be promoted to `landing`
only when the bounded safe scanner validates exactly one supported entry point. Original
MIME/extension and classifier version/source are always retained.

The first-release embedded editor accepts only a complete UTF-8 `.txt` whose Drive size is
≤1 MiB; `.srt` and `.vtt` remain sanitized preview/search formats. Save requires `edit`, a
live ancestry/capability check, and a
source Drive version/checksum precondition; an external change returns a typed conflict
instead of overwriting. `manage_metadata` exclusively writes GEO/language/offer/tags. For
unsupported, invalid, or truncated content, download remains available with `download`; a
“new version” requires `upload`, creates a distinct Drive file/material, adds
`relation='version_of'`, inherits metadata, and never silently updates the source. Explicit
replacement of an existing file is a separate confirmed action with all applicable rights.

**Rationale.** The existing `TranscriptTextModal` displays/copies/translates and exports a
result but has no source-content editor. Treating it as one would leave the supported-format
set undefined. A small text-only editor is bounded, testable, and uses the same transcript
ingestion data without implying binary/HTML editing. One shared classifier prevents sync and
upload paths from disagreeing about filters, preview, or tool eligibility.

**Alternatives considered.** An empty editor registry would technically avoid false support
but would not satisfy the specified editing workflow. Browser editing of HTML, media, or
archives is unsafe/out of scope. Replacing a file by name was rejected because Drive permits
duplicates and name lookup cannot identify an exact target.

## R14. OAuth approval release gate

**Decision.** Parse `DRIVE_OAUTH_MODE` from `unknown` through a closed shared guard. Missing
or invalid means `disabled`. Production is detected from normalized `WISHLY_SITE_URL`, the
request/OAuth-transaction origin, and canonical `PRODUCTION_SITE_ORIGIN` exported by
`release.ts`; any production signal wins. `drive-connect/start`, callback exchange,
reconnect/root replacement, and production credential refresh reject with
`OAUTH_APPROVAL_REQUIRED` unless mode is `testing` on an explicit non-production origin or
`verified`. Rejection occurs before provider/OAuth-state/Vault/connection side effects and
preserves existing team/catalog data. `.env.example`, deployment verification, health
diagnostics, and release runbook expose only the non-secret mode and never infer approval
from the presence of client credentials.

**Rationale.** Documentation alone is not an enforceable launch gate. A fail-closed enum and
origin check prevent a copied test environment or populated OAuth secret from silently
enabling a restricted-scope production flow.

Sources: [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration),
[verification requirements](https://support.google.com/cloud/answer/13464321?hl=en),
[restricted-scope security assessment](https://support.google.com/cloud/answer/13465431?hl=en).

**Alternatives considered.** A boolean cannot distinguish local testing from verified
production. Checking only for client id/secret confuses credential availability with Google
approval and fails open.
