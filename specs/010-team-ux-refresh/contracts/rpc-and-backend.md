# Contract: New SQL Functions (Supabase RPC)

All four follow the 001 security template: `security definer`, `set search_path = ''`,
fully-qualified names, permission checks via the existing membership helpers, audit rows for
mutations, narrow `grant execute to authenticated`. One forward-only migration
(`YYYYMMDDHHMMSS_team_ux_lifecycle.sql`) + `ROLLBACK.md` reverse steps + regenerated DB types
(`npm run types:supabase`) + regenerated PGlite contract SQL
(`scripts/generate-team-contract-sql.mjs`).

## 1. `leave_team(p_team uuid)`

Self-service exit for a non-owner member (FR-022, finding I2).

- **Auth**: caller must be an active member of `p_team`.
- **Guards**: caller is owner → error `OWNER_TRANSFER_REQUIRED` (same code the remove path
  uses today). Not a member → the standard not-found/denied error (no existence leak).
- **Effect**: deletes the caller's membership row (same row-level effect as `remove_member`,
  authorized on *self* instead of `manage_members`).
- **Returns**: `{ ok: true, warning_code: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }` — the standing
  Drive-ACL warning envelope, mirrored from `remove_member`.
- **Audit**: `membership.left` (actor = the leaver, target = the team).

## 2. `delete_draft_team(p_team uuid)`

Owner deletes a space that never completed setup (FR-023, finding I3).

- **Auth**: caller must be the team's owner.
- **Guards**: if any drive connection row has **ever** existed for the team (any state,
  including detached) → error `TEAM_NOT_DRAFT` (new stable code). Draftness is a server
  fact, stricter than the lobby's `setup_incomplete` presentation.
- **Effect**: deletes the team row with its memberships and invitations (draft teams have no
  catalog, operations, or tasks by construction — enforced by the guard).
- **Returns**: `{ ok: true }`.
- **Audit**: `team.draft_deleted`, written so it survives the team deletion per the audit
  table's existing FK/retention design (verified in the migration, not assumed).

## 3. `delete_team_task(p_team uuid, p_task uuid)`

Closes the task lifecycle (FR-027, finding R1).

- **Auth/Guards**: caller needs the task-edit permission (005 rule: task create/update =
  `edit`); task must belong to `p_team`.
- **Effect**: hard-deletes the task row and its attachment links (attachments' materials are
  untouched).
- **Returns**: `{ ok: true }`.
- **Audit**: `task.deleted` (target includes the task title snapshot for the audit trail).

## 4. `list_team_trashed_materials(p_team uuid, p_limit int default 50, p_before timestamptz default null)`

Read powering the trash view (FR-025, findings R2/D5).

- **Auth**: `view` permission on the team (same visibility rule as the catalog).
- **Returns**: newest-first page of rows with `lifecycle = 'trashed'`:
  `{ id, name, kind, trashed_at, parent_path_hint }`; keyset pagination via `p_before`.
- **No mutation**; restore goes through the existing `drive-ops/restore`.

## Client wrappers (`apps/web/src/api/team.ts`)

`teamApi.leaveTeam`, `teamApi.deleteDraftTeam`, `teamApi.deleteTask`,
`teamApi.listTrashedMaterials` — each `rpc → throwRpc → unknown-narrowing guard → typed
result`, per the file's existing pattern. No `as` casts.

## Error codes

| Code | New? | Where |
|---|---|---|
| `TEAM_NOT_DRAFT` | **new** | `delete_draft_team` on a team that ever had a connection |
| `OWNER_TRANSFER_REQUIRED` | reused | `leave_team` by the owner |
| `EXTERNAL_DRIVE_ACCESS_REMAINS` | reused (warning) | `leave_team` success envelope |

## Tests (PGlite, `tests/`)

Extend the team-contract harness: owner cannot leave; member leaves and loses reads; draft
delete refuses ever-connected teams and cascades cleanly; task delete honors the edit
permission and detaches links; trash listing honors `view` and pagination; every mutation
writes its audit row.
