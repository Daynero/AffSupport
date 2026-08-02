# Contract: PostgreSQL Functions, Grants & RLS

PostgreSQL 17 is the authority for membership, permissions, catalog visibility, operation
state and audit. `private` is not exposed through the Supabase Data API. Per the repository
constitution, **every feature SQL function**—read, action, policy/trigger helper, or
service-only—is `security definer`, sets `search_path=''`, and fully qualifies every object.
Function creation revokes default execute before granting only the intended role.

## Private policy helpers

All are `security definer`, `stable` where valid, `set search_path=''`, use fully-qualified
objects, and have execute revoked from `PUBLIC`, `anon` and direct client use unless a policy
or caller RPC requires an explicit narrow grant.

### `private.team_role(p_team, p_user default auth.uid()) → text|null`

Returns `owner` when `teams.owner_id=p_user`, otherwise active membership `base_role`; null
for removed/non-member/inactive profile. A client-facing wrapper may expose only caller's
role or require caller `manage_members` for another user.

### `private.effective_permissions(p_team, p_user default auth.uid()) → jsonb`

Loads generated `role_permissions`, overlays validated boolean overrides for non-owner, and
forces all flags for owner. Unknown/malformed keys are ignored/denied. Inactive/removed/
blocked returns all false.

### `private.can(p_team, p_flag, p_user default auth.uid()) → boolean`

Returns false for unknown flag, null identity, inactive profile, inactive membership, or
false effective permission. RLS policies pass `auth.uid()`; service workflows pass an actor
only through service-only grant/operation functions, never a client-selectable arbitrary id.

These helpers are indexed around active `(team_id,user_id)` and reverse `(user_id,team_id)`
lookups. They never query RLS-protected rows in a recursive way.

## Public atomic action RPCs

Each function derives caller from `auth.uid()`, validates every parameter, performs action +
audit in one transaction, and maps SQLSTATE/details to the shared machine-code union. The
function creation transaction revokes default `PUBLIC/anon` execute before granting only
`authenticated`.

- `create_team(p_name)` — team + owner membership; caller-active and name-conflict check.
- `update_membership(p_team,p_member,p_base_role,p_overrides)` — `manage_members`, not owner.
- `remove_member(p_team,p_member)` — `manage_members`, never owner; revoke grants.
- `transfer_ownership(p_team,p_to,p_demote_to)` — current owner only; deferred owner invariant.
- `create_invitation(...)`, `resend_invitation(...)`, `revoke_invitation(...)` — canonical
  email dedupe, team lock/capacity, hashed token and audit; Edge handles delivery.
- `accept_invitation(p_id,p_plain_token default null)`, `decline_invitation(...)` — caller
  identity, optional emailed-link hash, expiry/capacity/dedupe in one transaction.
- `update_material_metadata(p_team,p_material,p_patch)` — only metadata columns and generated
  vocab; `manage_metadata`.

`record_audit` is private and callable only under these functions/service completion. It has
no authenticated execute grant.

## Caller-checked read RPCs

All are `security definer` with execute granted only to `authenticated`. Each derives its
actor exclusively from `auth.uid()`, rejects null/inactive callers, and returns a closed
shape after explicit predicates:

- `list_my_teams()` starts from the caller's active memberships and computes only that
  caller's role/permissions;
- `list_my_invitations()` matches the caller's confirmed email/account identity and never
  returns token/hash fields;
- `search_materials(...)` first proves `private.can(p_team,'view',auth.uid())`, then applies
  mandatory exact `team_id` + `lifecycle='active'` predicates to rows, counts, facets, and
  suggestions;
- `get_team_vocab_and_facets(p_team)` uses the same caller/team proof and team predicates;
- `get_drive_connection_status(p_team)` checks membership and reveals connected email only
  after an explicit owner/admin predicate; credential/Vault/cursor fields never appear;
- `get_operation(p_team,p_operation)` checks the operation belongs to `p_team` and the caller
  can view that team before returning safe columns.

No caller-supplied actor is authority and no sensitive owner-created view is used as an
authorization shortcut. RLS stays enabled/forced as defense in depth, not as the missing
predicate of an owner-executed function.

## Service-only functions

Every service function is also `security definer`; execute is granted only to the backend
service role. User endpoints must complete their caller-scoped authorization before calling:

- temporary `service_direct_add_registered_member(actor,team,email,role)` only after the
  caller-authenticated exact-account lookup; it rechecks `manage_members`, confirmed active
  identity, duplicate and 50-member capacity under the same team lock, then inserts/audits;
- OAuth transaction create/consume and Vault credential create/read/update/delete;
- issue/consume/revoke hashed transfer grants;
- start/finalize/fail/cancel operations and name reservations, including text edit and
  separate `version_of` finalization;
- sync lease/claim/checkpoint/retry/classify/transcript-ingest/tombstone;
- append audit after a verified external side effect.

Grant consumption locks the row, verifies hash/scope/expiry/use limit/operation binding,
and calls `private.can(..., actor_id)` again. It never returns Vault ids or refresh tokens to
the client; the Edge function receives only the credential needed for its current provider
call.

## Owner invariant

`teams.owner_id` is non-null. A deferred constraint trigger on `teams` and `team_members`
checks at transaction end that exactly one active membership matches `(team_id, owner_id)`.
Owner is not stored in `team_members.base_role`, eliminating mutable duplicate truth.

All direct writes that could alter team owner/membership are revoked. Tests cover concurrent
create/transfer/remove/account-delete attempts. The existing account-delete Edge Function
calls an ownership preflight and returns `OWNERSHIP_TRANSFER_REQUIRED` before Auth deletion.

## RLS/grant pattern

Every public table follows this shape (policy predicate varies by table). Private tables
also enable/force RLS and additionally expose no client policy or grant:

```sql
alter table public.example enable row level security;
alter table public.example force row level security;
revoke all on table public.example from public, anon, authenticated;

grant select (safe_column_1, safe_column_2) on public.example to authenticated;
create policy example_select on public.example
for select to authenticated
using (private.can(team_id, 'view', auth.uid()));
```

- Direct writes are absent unless demonstrably simpler and safe. An allowed update has both
  `USING` and `WITH CHECK`, plus column-scoped grants.
- Team/member/invite/connection/audit admin reads use the corresponding owner/
  `manage_members` predicate, not blanket `view`.
- Private/Vault credential tables have no client grants and are not in exposed schemas.
- `team_operations` Realtime exposes a safe publication table/columns; credential, grant,
  audit target, transcript and provider payloads are never published.

## Required pgTAP/local integration proofs

Run on `supabase start` with PostgreSQL major version 17:

1. anon/authenticated owner/admin/editor/viewer/non-member matrix for tables and RPCs;
2. blocked/removed member denied even with a valid JWT;
3. unknown permission flag false; arbitrary `p_user` and foreign `team_id` rejected;
4. an inventory of every feature function proves `pg_proc.prosecdef=true`, an empty
   `search_path` in `proconfig`, and exactly the intended authenticated/service-role EXECUTE
   ACL; `PUBLIC`/`anon` are always revoked;
5. authenticated cannot select credential/Vault/grant/session/name-reservation secrets;
6. owner concurrency never commits zero/two owners; account deletion requires transfer;
7. invite email/account cross-form dedupe, 14-day expiry and atomic 50-member cap;
8. null caller, spoofed actor, foreign team, removed/inactive profile, and caller search-path
   shadow objects fail; search returns no hidden row/count/facet/suggestion;
9. OAuth state replay/expiry/cross-team swap and transfer-grant replay fail;
10. catalog cron rejects publishable/user keys and accepts only its named secret;
11. Realtime publication contains safe columns and removed member cannot authorize/refetch;
12. generated role/TTL/vocab/classifier/editor/settings rows equal
    `@video-compressor/shared` contract.

PGlite is limited to pure query/normalization/idempotency logic; it is not evidence for
Supabase Auth roles, RLS, Vault, Cron, publications or grants.
