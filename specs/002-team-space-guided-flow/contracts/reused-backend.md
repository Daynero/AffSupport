# Contract: Reused 001 Backend (no changes)

This feature makes **no backend change**. It reuses the following existing `teamApi`
(`apps/web/src/api/team.ts`) wrappers and their 001 endpoints exactly as-is. Listed to make the
"frontend-only" boundary explicit and reviewable.

## Navigation & lobby

| Purpose | `teamApi` method | Underlying 001 endpoint | Change |
| --- | --- | --- | --- |
| List the user's spaces | `listTeams()` | `rpc('list_my_teams')` | none |
| Read connection readiness for card state | `getConnectionStatus(teamId)` | `rpc('get_drive_connection_status')` | none |

## Create wizard

| Purpose | `teamApi` method | Underlying 001 endpoint | Change |
| --- | --- | --- | --- |
| Create the team row (name step) | `createTeam(name)` | `rpc('create_team')` | none |
| Start Drive OAuth | `startDriveOAuth(teamId)` | `drive-connect` (`start`) | none |
| Browse folders | `listFolders(teamId,'root',token)` | `drive-connect` (`folders`) | none |
| Confirm root (2-phase) | `confirmDriveRoot(...)` | `drive-connect` (`confirm`) | none |

## Workspace shell, settings, catalog

| Purpose | `teamApi` method | Underlying 001 endpoint | Change |
| --- | --- | --- | --- |
| Browse folder contents | `listMaterials(teamId, parent)` | `rpc('list_team_materials')` | none |
| Search (on demand) | `searchCatalog(teamId, req)` | `rpc('search_materials')` | none |
| Content-aware facets | `getCatalogVocabulary(teamId)` | `rpc('get_team_vocab_and_facets')` | none |
| Members panel | `listMembers` / `updateMembership` / `removeMember` / `transferOwnership` | corresponding RPCs | none |
| Invitations panel | `listInvitations` / `createInvitation` / `resendInvitation` / `revokeInvitation` / `directAddMember` | `team-invitations` + RPCs | none |
| Drive settings panel | `replaceDriveRoot` / `detachDrive` | `drive-connect` | none |
| Audit panel | `listAuditEvents` | `rpc('list_team_audit_events')` | none |
| Preview / processing | `previewMaterial` / `startProcess` / `getOperation` / … | `drive-transfer` / `drive-ops` | none |

## Assertions

- No new RPC, Edge Function, table, RLS policy, grant, or migration is introduced.
- No change to `packages/shared` **except** the optional addition of a single analytics event
  **name** to `TeamAnalyticsEventName` (Decision 7); if added, it follows the existing typed-
  props discipline and the shared→SQL generator is unaffected (analytics names are not part of
  the migration snapshot).
- `AGENT_API_VERSION`, `PRODUCT_VERSION`, and the release manifest are untouched.
