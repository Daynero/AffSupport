# Contract: Teams, Members, Ownership & Invitations

Covers FR-001…FR-017 and the owner/account-lifecycle edge cases. Domain mutations are
atomic RPCs; invitation delivery is an Edge side effect after the database transition.
Every SQL RPC here is caller-checked `security definer` with `search_path=''`, fully-qualified
objects, default execute revoked, and a narrow `authenticated` grant. Actor identity comes
only from `auth.uid()`.

## Team and membership RPCs

### `create_team(p_name) → TeamContext`

- **Guard**: authenticated profile is active.
- **Validate**: trimmed name 1–120 chars; under a caller-scoped transaction lock, no
  case-insensitive conflict among the caller's active teams.
- **Effect**: insert team + active membership atomically; set the caller as non-null
  `owner_id`; append audit.
- **Errors**: `INVALID_INPUT`, `NAME_CONFLICT`.
- Direct table insert is not granted.

### `list_my_teams() → TeamContext[]`

Returns active memberships with computed role, effective permissions, connection state and
safe display fields. Active-team choice remains a web preference; it is never accepted as
authorization proof. The function starts from `auth.uid()` active membership and cannot list
another user's teams.

### `lookup_invitable_account(p_team, p_email) → { exists, displayName? }`

- **Guard**: caller has `manage_members` in the selected team (team id is a parameter).
- Performs an exact confirmed-email lookup and returns minimal display data; it never lists
  arbitrary accounts or exposes account status/internal ids without a match.
- The create-invite flow may accept email only; the server resolves/stores user id.

### `update_membership(p_team, p_member, p_base_role?, p_overrides?) → Membership`

- **Guard**: `manage_members`; target is active; owner cannot be edited here.
- **Validate**: base role is non-owner; override is a sparse object of known boolean flags.
- **Effect**: update + audit in one transaction. The next protected action reads the new
  row; no permission cache authorizes a request.
- **Errors**: `PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_INPUT`.

### `remove_member(p_team, p_member) → { ok: true }`

- **Guard**: `manage_members`; target is not owner.
- **Effect**: mark removed, revoke outstanding transfer grants, append audit. Direct Google
  access remains independent and the response includes a UI warning code.
- **Errors**: `PERMISSION_DENIED`, `OWNER_TRANSFER_REQUIRED`, `NOT_FOUND`.

### `transfer_ownership(p_team, p_to_user, p_demote_to) → TeamContext`

- **Guard**: caller is current owner; target is an active member; explicit demotion role is
  `admin|editor|viewer`.
- **Effect**: atomically set `teams.owner_id`, update the former owner's base role, keep both
  memberships active, revoke stale owner-only grants, and append audit. Deferred invariant
  proves that the non-null owner is active at commit.
- **Errors**: `PERMISSION_DENIED`, `INVALID_INPUT`, `NOT_FOUND`.

## Invitation RPC + Edge delivery

### `POST /functions/v1/team-invitations/create`

**Body**: `{ teamId, email, initialRole, idempotencyKey }`.

- **Guard**: JWT + `manage_members`; active team.
- Canonicalizes confirmed account email when one exists; account/email forms share one
  `target_email` dedupe key.
- Under a team lock, refuses an active member, an existing pending invite, or a team already
  at 50 active members.
- Creates a hashed-token invitation expiring in 14 days and commits audit first.
- Attempts Resend delivery. Database success is not rolled back by provider outage: response
  includes `deliveryState: sent|failed`, and UI can copy link/resend.
- **Errors**: `ALREADY_MEMBER`, `ALREADY_INVITED`, `TEAM_MEMBER_LIMIT`,
  `INVALID_INPUT`, `PERMISSION_DENIED`.

### `list_my_invitations() → InvitationSummary[]`

Returns pending invitations where the signed-in user's confirmed email matches or their
account id is the target. Expired rows are materialized/returned as expired; tokens/hashes
are never returned. The definer applies this identity predicate explicitly rather than
relying on RLS. This is the in-app fallback for failed email.

### `accept_invitation(p_invitation, p_token default null) → TeamContext`

- **Guard**: authenticated active profile; confirmed email/id matches target; pending state
  and `now() < expires_at`. An emailed deep link must also match the token hash; an invite
  returned by authenticated `list_my_invitations()` may be accepted by id without exposing a
  token. A token never substitutes for confirmed identity.
- **Effect**: under one team lock re-check 50-member cap and membership dedupe, insert active
  membership, mark accepted, append audit.
- **Errors**: `PERMISSION_DENIED`, `EXPIRED`, `ALREADY_MEMBER`, `TEAM_MEMBER_LIMIT`,
  `NOT_FOUND`.

### `decline_invitation(p_invitation, p_token default null) → { ok: true }`

Same target identity rule and optional deep-link token check; transition
`pending → declined`; audit.

### `POST /functions/v1/team-invitations/{id}/revoke|resend`

- **Guard**: JWT + `manage_members`.
- Revoke: `pending → revoked` and invalidate token.
- Resend: rotate token, set `expires_at=now()+14d`, reset delivery state, send email, audit.
  It does not create a second invitation row.

One scheduled database sweep moves stale pending rows to `expired`; every accept call also
checks time, so sweep delay cannot extend validity.

## Existing account lifecycle integration

`supabase/functions/delete-account` performs `owned_team_count(auth.uid())` before deleting
the Auth user. If nonzero, it returns
`409 { ok:false, error:{ code:'OWNERSHIP_TRANSFER_REQUIRED', retryable:false,
details:{ teamCount } } }`. A blocked profile fails `can()` and every new team action even
while its JWT is otherwise valid. Deleting a non-owner removes/revokes active membership and
grants while audit retains a logical actor id/label snapshot.

## Guarantees

- Exactly one owner identity at every committed state.
- No direct table write can bypass role, capacity, identity, expiry, or audit rules.
- No duplicate active membership or cross-form pending invite.
- Permission/member removal affects the next protected action; already-started transfer may
  finish only under its existing short-lived operation grant.
- Denied actions change neither team state nor Drive state.
