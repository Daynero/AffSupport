# Contract: Drive Quick Share & Team Contributions

## Share status

`POST /functions/v1/library-ops/share/status`

Body: `{ teamId, materialId }`.

- Guard: active member with `view`; exact active material/team; live root ancestry.
- Fetches current Drive permission/capabilities and exact provider `webViewLink` server-side.
- Returns `{ state:'public', copyToken, expiresAt }` when Anyone-with-link reader access exists,
  or `{ state:'restricted', canShare, rememberedApproval }` otherwise.
- The browser never receives a broad Google token or raw permission list. A public copy token
  is short-lived, exact-item-scoped and exchanges for the URL only after a current recheck.

## Open permission and copy

`POST /functions/v1/library-ops/share/copy`

Body: `{ teamId, materialId, allowIfRestricted, rememberChoice, idempotencyKey }`.

- Re-fetches exact item, root ancestry, link state and `canShare` on every call.
- Already public: requires only `view`, changes nothing and returns the current web URL.
- Restricted: requires `allowIfRestricted=true`, Soty `edit`, live Drive `canShare`, then adds
  only an Anyone-with-link reader permission to this exact material and verifies it.
- `rememberChoice=true` upserts only caller+team prompt preference after successful explicit
  approval. A remembered preference lets the client send `allowIfRestricted=true` later but
  never bypasses server checks.
- Failure never reports copied and never changes another asset/folder/Library.

Open in Drive obtains the exact current web URL through the same status boundary. Download
continues to use feature 001 grants.

Preference RPCs let the caller read, set or reset only their `(team,user)` row. Team settings
shows the current choice and reset action.

## Contribution writes

Contribution rows have a closed schema, not arbitrary properties:

- `local_processing`: accepted/skipped/failed processing attempt with actor, optional opaque
  agent instance, kind, outcome and time;
- `human_activity`: successful upload item, Finds→Library selection, task creation or task
  completion with actor, action, outcome and time.

Service/caller functions derive the actor from the operation/task context. They reject
unknown category/action/outcome values. There is no content/name/path/URL/provider-id/token/
transcript/metadata/score field to populate.

## Aggregate reads

Owner/admin may request counts grouped separately by category, action and time bucket.
Responses never rank people in one combined score. The read-only analytics path may add
separate aggregates later; no ad-hoc production SQL or Busy Bees UI is required here.

## Privacy/security proof

Tests recursively inspect Edge/agent error/log/audit/Realtime/contribution/analytics fixtures
and fail if they contain transcript bodies, filenames, private paths, Drive URL/id,
permission resource, grant/lease/session tokens or provider response bodies. Share URLs exist
only in the immediate authorized response/clipboard action.

Stable errors: `PERMISSION_DENIED`, `NOT_FOUND`, `ROOT_ESCAPE`, `SHARE_NOT_ALLOWED`,
`DRIVE_UNAVAILABLE`, `RATE_LIMITED`, `NEEDS_REAUTH`, `INVALID_RESPONSE`.
