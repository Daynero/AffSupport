# Phase 1 Data Model: Командний медіапростір Soty

Postgres owns relational authority and searchable metadata; Drive owns file bytes; Vault
owns refresh-token plaintext. Public **and private** tables enable/force RLS. Public tables
use narrow column grants; private-schema tables are also absent from the Data API, have all
client privileges revoked, and are reachable only from narrowly granted backend functions.

All primary ids are UUID, times are `timestamptz`, emails use `citext`, and all external
Drive ids are opaque text. Shared contract constants are generated into database lookup
rows and verified for parity; SQL functions do not hand-copy role defaults or vocabularies.

## Shared enumerations and limits

- `Role`: `owner | admin | editor | viewer` (`owner` is computed, not stored as a base role)
- `BaseRole`: `admin | editor | viewer`
- `PermissionFlag`: `view | download | upload | edit | delete | process |
manage_members | manage_metadata`
- `InvitationState`: `pending | accepted | declined | revoked | expired`
- `DeliveryState`: `pending | sent | failed`
- `MaterialCategory`: `video | image | archive | transcript | landing | other`
- `MaterialLifecycle`: `active | trashed | missing`
- `TranscriptIngestState`: `not_applicable | pending | full | truncated | invalid_encoding |
unavailable`
- `ClassificationSource`: `mime | extension | inspected_landing | fallback`
- `OperationState`: `pending | running | succeeded | canceled | failed`
- `ConnectionState`: `pending | connected | needs_reauth | unavailable | detached`
- `DriveOAuthMode`: `disabled | testing | verified` (deployment configuration; absent/invalid
  parses as `disabled` and is not stored per team)
- `INVITE_TTL_DAYS = 14`, `TEAM_MAX_ACTIVE_MEMBERS = 50`
- `TRANSCRIPT_INDEX_MAX_BYTES = 1 MiB`; the embedded editor format is `.txt` only and
  requires a complete valid UTF-8 source no larger than the same bound. `.srt|.vtt` are
  preview/search formats, not direct-edit formats.
- Range request max 32 MiB; browser full-download max 100 MiB; agent intake max 100 GiB;
  preview/tool-specific limits remain the existing shared/agent limits.

`role_permissions`, `geo_options` (ISO 3166-1 alpha-2), `language_options` (BCP 47
allowlist), and `team_contract_settings` are read-only generated lookup tables.

Generated role defaults are exact:

- owner: all flags; ownership/root powers are additionally owner-only special actions;
- admin: all eight flags, but no ownership transfer/root replacement;
- editor: `view,download,upload,edit,process,manage_metadata`;
- viewer: `view,download`.

## Core entities

### Team (`teams`)

| Field                      | Type                | Rules                                         |
| -------------------------- | ------------------- | --------------------------------------------- |
| `id`                       | uuid PK             |                                               |
| `name`                     | text                | trimmed, 1–120 chars                          |
| `owner_id`                 | uuid → `auth.users` | non-null; the single canonical owner identity |
| `status`                   | text                | `active` in v1; `archived` reserved           |
| `created_at`, `updated_at` | timestamptz         | trigger-maintained                            |

- Direct insert/update is forbidden; `create_team()` and `transfer_ownership()` are the
  mutation paths.
- `create_team()` takes a transaction-scoped lock keyed by caller, then checks
  case-insensitive conflict across the caller's currently active teams (FR-001), not merely
  teams they own; concurrent creates cannot both pass.
- A deferred constraint trigger proves that `(id, owner_id)` has one active membership at
  transaction end. Because `owner_id` is one non-null value, this proves exactly one owner.

### TeamMembership (`team_members`)

| Field                     | Type              | Rules                                  |
| ------------------------- | ----------------- | -------------------------------------- |
| `id`                      | uuid PK           |                                        |
| `team_id`                 | uuid → teams      | indexed with `user_id`                 |
| `user_id`                 | uuid → auth.users | reverse index `(user_id, team_id)`     |
| `base_role`               | text              | `admin                                 | editor   | viewer` only |
| `permission_overrides`    | jsonb             | sparse object of known flags → boolean |
| `status`                  | text              | `active                                | removed` |
| `joined_at`, `removed_at` | timestamptz       | `removed_at` iff removed               |

- Partial unique `(team_id, user_id) WHERE status='active'`.
- Effective role is `owner` when `teams.owner_id=user_id`, else `base_role`.
- Owner ignores overrides and receives all permissions. Other roles merge generated
  defaults with validated overrides. Unknown flags always deny.
- `can()` additionally requires `profiles.account_status='active'`.
- Membership/role/override writes are RPC-only and audit in the same transaction.

### Invitation (`team_invitations`)

| Field                                      | Type                | Rules                                           |
| ------------------------------------------ | ------------------- | ----------------------------------------------- |
| `id`, `team_id`                            | uuid                | team FK                                         |
| `target_email`                             | citext              | canonical confirmed target; always present      |
| `target_user_id`                           | uuid nullable       | present for account invite                      |
| `initial_role`                             | BaseRole            | never owner                                     |
| `inviter_id`                               | uuid                | logical actor id                                |
| `accept_token_hash`                        | bytea               | SHA-256 of random token; plaintext never stored |
| `state`                                    | InvitationState     |                                                 |
| `delivery_state`, `delivery_error_code`    | DeliveryState, text | delivery is not acceptance                      |
| `expires_at`, `created_at`, `last_sent_at` | timestamptz         | 14-day expiry                                   |

- One partial unique `(team_id, target_email) WHERE state='pending'` dedupes account/email
  forms. `citext` extension is enabled by migration.
- Acceptance atomically validates signed-in confirmed identity, expiry, membership dedupe,
  and the 50-member cap under a team lock. Email deep links also validate the token hash;
  authenticated in-app invitations can accept by id without exposing token plaintext.
- Resend rotates token + expiry. Scheduled expiry is a convenience; accept-time expiry is
  authoritative.

## Drive connection and catalog

### GoogleCredential (`private.google_drive_credentials`)

| Field                                      | Type        | Rules                                                     |
| ------------------------------------------ | ----------- | --------------------------------------------------------- |
| `id`                                       | uuid PK     |                                                           |
| `connected_by`                             | uuid        | Soty account that consented                               |
| `google_permission_id`                     | text        | stable Drive principal identifier                         |
| `google_account_email`                     | text        | display only                                              |
| `vault_secret_id`                          | uuid        | references encrypted refresh token; never client-readable |
| `scope`                                    | text        | exact granted scopes                                      |
| `created_at`, `updated_at`, `last_used_at` | timestamptz |                                                           |

One credential may back multiple team roots only after the same owner explicitly reuses the
connection. Detaching the last reference revokes/deletes the Vault secret. `invalid_grant`
marks all references `needs_reauth` without deleting team/catalog data.

### OAuthTransaction (`private.drive_oauth_transactions`)

| Field                       | Type        | Rules                       |
| --------------------------- | ----------- | --------------------------- |
| `state_hash`                | bytea PK    | high-entropy one-time state |
| `team_id`, `actor_id`       | uuid        | bound owner + team          |
| `pkce_verifier_secret_id`   | uuid        | short-lived Vault secret    |
| `expires_at`, `consumed_at` | timestamptz | max 10 minutes; one use     |

Callback consumption is atomic; expired/replayed/cross-team state fails without storing a
credential.

### DriveConnection (`team_drive_connections`)

| Field                                                    | Type            | Rules                                   |
| -------------------------------------------------------- | --------------- | --------------------------------------- |
| `id`, `team_id`                                          | uuid            | one non-detached connection per team    |
| `credential_id`                                          | uuid            | private column; no client select grant  |
| `root_folder_id`, `root_resource_key`                    | text            | root shortcut forbidden                 |
| `root_folder_name`                                       | text            | display snapshot                        |
| `drive_id`                                               | text nullable   | null for My Drive; set for Shared Drive |
| `drive_kind`                                             | text            | `my_drive                               | shared_drive` |
| `capability_snapshot`                                    | jsonb           | UI hint only                            |
| `capabilities_checked_at`                                | timestamptz     | staleness visible                       |
| `state`                                                  | ConnectionState |                                         |
| `initial_sync_state`                                     | text            | `not_started                            | scanning      | replaying | ready | failed` |
| `change_page_token`, `last_synced_at`, `last_error_code` | text/time       | checkpoint                              |
| `created_at`, `updated_at`                               | timestamptz     |                                         |

Connection status RPC returns folder/state to members; connected account email only to
owner/admin. It never exposes credential/Vault ids. Capability snapshots never authorize an
action; live `files.capabilities` and ancestry do.

### Material (`team_materials`)

| Field                                                     | Type                      | Rules                                 |
| --------------------------------------------------------- | ------------------------- | ------------------------------------- |
| `id`, `team_id`, `connection_id`                          | uuid                      |                                       |
| `drive_file_id`, `drive_id`, `resource_key`               | text                      | unique `(team_id, drive_file_id)`     |
| `parent_folder_id`                                        | text                      | cached, non-authoritative             |
| `name`, `mime_type`, `file_extension`                     | text                      | original type preserved               |
| `kind`                                                    | text                      | `file                                 | folder | shortcut` |
| `shortcut_target_id`, `shortcut_target_resource_key`      | text nullable             | never blindly dereferenced            |
| `category`                                                | MaterialCategory nullable | null for folders; derived for files   |
| `classification_version`, `classification_source`         | int/text                  | canonical classifier provenance       |
| `landing_validation_state`, `landing_validation_version`  | text/text nullable        | scanner proof bound to source version |
| `landing_validation_fingerprint`                          | text nullable             | safe package fingerprint              |
| `size_bytes`, `modified_at`, `drive_version`, `checksum`  | bigint/time/text          | nullable as Drive allows              |
| `lifecycle`                                               | MaterialLifecycle         | tombstone instead of row deletion     |
| `geo`, `language`                                         | text nullable             | generated lookup FK                   |
| `offer`                                                   | text nullable             | normalized free text                  |
| `tags`                                                    | text[]                    | normalized/deduped free text          |
| `transcript_text`                                         | text nullable             | max 1 MiB; never Realtime/analytics   |
| `transcript_ingest_state`, `transcript_truncated`         | text/bool                 | explicit preview/search state         |
| `transcript_indexed_bytes`                                | int                       | byte count at UTF-8 boundary          |
| `transcript_source_version`, `transcript_source_checksum` | text nullable             | refresh/invalidation identity         |
| `transcript_ingested_at`, `transcript_error_code`         | time/text nullable        | safe status, no provider body         |
| `search_tsv`                                              | tsvector                  | generated with `simple` configuration |
| `preview_state`, `preview_error_code`                     | text                      | typed availability                    |
| `created_at`, `updated_at`, `trashed_at`, `missing_at`    | timestamptz               |                                       |

- Client catalog access is through caller-checked definer RPCs that explicitly prove team
  `view` and constrain every row/count/facet to that team; direct client writes to Drive
  identity/system/text columns are revoked and RLS remains enabled/forced.
- Metadata writes use `update_material_metadata()` and only touch GEO/language/offer/tags.
- Rename/move/content writes never call the metadata function. Embedded content save is
  eligible only for complete valid UTF-8 `.txt` ≤1 MiB and carries the source
  Drive version/checksum as an optimistic precondition; success refreshes ingest identity.
- The canonical classifier is MIME-first for recognized explicit types, uses normalized
  extension only for absent/generic/unrecognized MIME, and permits bounded scanner promotion
  from archive to landing. Sync, upload finalize, content-edit finalize, and reconciliation
  invoke it.
- Search vector includes normalized name, tags, GEO, offer, language, and transcript text.
- Btree indexes cover `(team_id,lifecycle,<facet>)`; GIN covers `search_tsv`; partial indexes
  cover missing GEO/offer/language.
- Normal catalog results exclude tombstones, but caller-checked provenance/audit RPC output
  may reference them.

### MaterialLink (`team_material_links`)

| Field                                                      | Type      | Rules                            |
| ---------------------------------------------------------- | --------- | -------------------------------- |
| `id`, `team_id`                                            | uuid      |                                  |
| `source_material_id`, `derivative_material_id`             | uuid      | source remains as tombstone      |
| `relation`                                                 | text      | `processed_from` or `version_of` |
| `source_name_snapshot`, `tool_id`, `tool_contract_version` | text/int  | durable explanation              |
| `created_by`, `created_at`                                 | uuid/time |                                  |

Move/rename changes no link. Trash/lost access changes source lifecycle but preserves both
the id and human-readable snapshot. `version_of` is created only after the new distinct
Drive file is verified; metadata is copied in the same database finalization transaction.
Both endpoints must belong to the same team and differ. The link graph rejects cycles, and a
new material has at most one immediate `version_of` predecessor; one source may still have
multiple version branches.

## Operations, transport, sync, and audit

### Operation (`team_operations`)

Fields: `id`, `team_id`, `actor_id`, `kind` (`upload|download|rename|move|trash|restore|
content_edit|new_version|process`), `state`, `stage`, `progress` (0–100),
`source_material_id`, `destination_folder_id`, `result_material_id`, `idempotency_key`,
`request_nonce`, `reserved_name_key`, `reservation_expires_at`,
`reservation_released_at`, `bytes_total`, `bytes_completed`, `error_code`, `created_at`,
`updated_at`, `finished_at`.

- Unique `(team_id, actor_id, kind, idempotency_key)`.
- A partial unique reservation on `(team_id, destination_folder_id, reserved_name_key)`
  where `reservation_released_at is null` serializes Soty's no-silent-duplicate policy
  even though Drive itself permits duplicate names. Finalize/cancel releases explicitly;
  a sweeper releases timed-out rows using `reservation_expires_at` (the volatile clock is
  not embedded in an index predicate).
- Valid transitions: `pending → running → succeeded|canceled|failed`; terminal is immutable.
- Result/link/catalog success follows Drive verification, never merely upload initiation.
- Realtime publishes only safe, small operation columns; progress is throttled.

### TransferGrant (`private.team_transfer_grants`)

Fields: `id`, `token_hash`, `operation_id`, `actor_id`, `purpose`
(`preview_range|download_range|process_input|process_output|finalize`), bound material/
destination/tool, `max_range_bytes`, `expires_at`, `revoked_at`, `uses`, `max_uses`.

Only hashes are stored. Consumption is transactional, scope checked, and current actor
membership/permission is re-evaluated for each new range/finalize action. Preview grants may
allow multiple bounded Range requests; mutation/finalize grants are one-use.

### CatalogSyncJob (`private.catalog_sync_jobs`)

Fields: `id`, `connection_id`, `phase` (`initial_scan|change_replay|incremental|reconcile`),
`cursor`, `folder_queue`, `lease_owner`, `lease_expires_at`, `attempts`, `next_attempt_at`,
`state`, `last_error_code`, timestamps.

Workers claim with a lease/`SKIP LOCKED`, checkpoint every Drive page, use exponential
backoff for quota/5xx, and idempotently classify/upsert/tombstone. Transcript candidates are
read in bounded ranges and checkpoint their source version/checksum; a changed identity
replaces the text, while trash/missing clears it from normal search. One cron schedule feeds
workers; there is no per-team cron.

### AuditEvent (`team_audit_events`)

Fields: `id`, `team_id`, `actor_id` (logical UUID retained after account deletion),
`actor_label_snapshot`, `action`, `target`, `result`, `error_code`, `occurred_at`.

Append-only: no client insert/update/delete; action/finalization functions write it.
Owner/admin can read. Target payload is allowlisted and contains no Drive token, transfer
token, resumable session URI, file content, or transcript text.

## State and relationship summary

```text
auth.users ──< team_members >── teams(owner_id)
teams ──< team_invitations
private.google_drive_credentials ──< team_drive_connections ──< team_materials
team_materials ──< team_material_links >── team_materials
teams ──< team_operations ──< private.team_transfer_grants
team_drive_connections ──< private.catalog_sync_jobs
teams ──< team_audit_events
```

## Database function boundary

Every function below is `security definer`, has `set search_path=''`, and fully qualifies
every object. Its creation transaction revokes default `PUBLIC` execute before making a
narrow grant. No function accepts a user id as proof of the actor.

- Caller-facing action definers (grant only `authenticated`): `create_team`,
  `update_membership`, `remove_member`, `transfer_ownership`, `create_invitation`,
  `accept_invitation`, `resend_invitation`, `revoke_invitation`, and
  `update_material_metadata`. Each derives the actor from `auth.uid()`, rejects inactive/
  removed/foreign-team callers, and checks the exact permission before mutation.
- Caller-facing read definers (grant only `authenticated`): `list_my_teams` filters from the
  caller's active memberships; `list_my_invitations` matches the caller's confirmed email;
  `search_materials`/`get_team_vocab_and_facets` explicitly check `view` and constrain all
  rows/counts/facets to one authorized team; `get_operation` checks the operation's team and
  caller membership; connection status reveals connected email only after owner/admin check.
- Private helper definers: `private.team_role`, `private.effective_permissions`,
  `private.can`, ownership constraint triggers, and audit helpers. Unknown permission is
  false; any helper reachable from a policy has only the minimum intended execute grant.
- Service-only definers (grant only `service_role`): credential access, OAuth-state
  consumption, temporary `service_direct_add_registered_member` membership creation after
  an Edge caller-scoped gate, operation/content-edit/new-version finalize, transfer-grant
  consumption, sync lease/checkpoint/transcript ingestion, and audit append. The direct-add
  function rechecks the supplied actor, exact confirmed account, capacity and duplicate
  state under a team lock. Execute is revoked from `PUBLIC`, `anon`, and `authenticated`.

An inventory pgTAP assertion covers every feature function: `pg_proc.prosecdef=true`, empty
`search_path` in `proconfig`, exact ACL, null/spoofed/inactive/foreign-team rejection, no
hidden row/count/facet leak, and immunity to caller-created objects on `search_path`.

`delete-account` calls an ownership preflight and returns
`OWNERSHIP_TRANSFER_REQUIRED` rather than breaking the owner invariant.
