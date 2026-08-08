# Phase 1 Data Model: Спрощений покроковий інтерфейс командного простору

This feature adds **no database entities, columns, or migrations**. The "entities" here are
client-side state shapes that drive the lobby, wizard, and shell. Authoritative data continues
to come from the 001 `teamApi` surface (`TeamContextSnapshot`, `DriveConnectionStatus`,
`DriveRootResult`, catalog types). All shapes below are TypeScript string-literal unions /
discriminated results, consistent with Principle I.

## 1. Entered-space selection (persisted)

The single persisted client value. Replaces the passive auto-select.

- **Storage**: `localStorage['soty.active-team.v1']` (existing key, re-purposed).
- **Shape**: `string | null` — a team UUID or "no space entered".
- **Validation**: on read, must match the existing UUID regex; anything else → `null`.
- **Derived**: `enteredSpace = teams.find(t => t.id === activeTeamId) ?? null`. Note the
  removed `?? teams[0]` fallback — an unresolved id yields `null` (→ lobby), and the stale id
  is cleared.
- **Transitions**:
  - `enterSpace(id)` — validate membership in `teams`; set + persist; workspace shell renders.
  - `leaveSpace()` ("Change space") — set `null`; clear storage; lobby renders.
  - Membership lost / space deleted (Realtime) — set `null`; lobby renders (FR-007).

## 2. Lobby space item (derived, read-only)

One card per team the user belongs to, derived from `TeamContextSnapshot`.

| Field       | Source                                  | Notes                                        |
| ----------- | --------------------------------------- | -------------------------------------------- |
| `id`        | `snapshot.id`                           | team UUID                                    |
| `name`      | `snapshot.name`                         | shown on the card                            |
| `role`      | `snapshot.role`                         | owner/admin/editor/viewer                    |
| `readiness` | derived from `snapshot.connectionState` | `ready` \| `setup_incomplete` \| `preparing` |

- **Readiness derivation**:
  - `ready` — `connectionState === 'connected'`: enterable normal card.
  - `setup_incomplete` — `connectionState ∈ {none, detached}` (never had / lost its root) **and
    the viewer is owner**: shown as a "Continue setup" card that resumes the wizard's folder
    step.
  - `preparing` — a root exists but is not yet usable to this viewer
    (`connectionState ∈ {pending, needs_reauth, unavailable}`, or `none` for a **non-owner**):
    shown as "Space is being set up" (read-only), covering the invited-member edge case.
- **Empty set** (`teams.length === 0`): the lobby shows the welcoming empty state that leads
  straight into create (FR-006), not a list.

## 3. Create-space wizard state (transient)

Lives only for the duration of creation; never persisted.

- **Shape** (discriminated by `step`):
  - `{ step: 'name', nameDraft: string, error?: TeamErrorCode }`
  - `{ step: 'folder', teamId: string, name: string, connect: DriveConnectSubState }`
  - `{ step: 'done', teamId: string }`
- **Fields / rules**:
  - `nameDraft` — required; normalized `NFC` + collapsed whitespace; length 1…120 (reuses the
    existing `CreateTeamDialog` validation). Empty/invalid blocks "Continue" (FR-009).
  - Advancing name→folder calls `teamApi.createTeam(nameDraft)` and carries the returned
    `teamId` (Decision 3). A `NAME_CONFLICT` code keeps the user on the name step.
  - `folder` step reuses the drive-connect sub-flow; it cannot complete until the sub-state
    reaches `connected` (FR-010). `OAUTH_APPROVAL_REQUIRED` is surfaced and blocks completion
    (FR-013).
  - `done` triggers `enterSpace(teamId)`.
- **Abandonment**: leaving before `connected` leaves a `setup_incomplete` team (entity 2),
  resumable from the lobby; no half-created space is presented as ready (FR-012, SC-007).

### DriveConnectSubState (reused, unchanged)

Mirrors the existing `DriveConnectionPanel` states, reused verbatim:
`idle → authorizing → browsing_folders → confirmation_required → connected`, plus
`unavailable | approval_required` error leaves. Backed by `startDriveOAuth`, `listFolders`,
`confirmDriveRoot`. No change to these types.

## 4. Workspace shell view state (transient)

- **Shape**: `{ view: 'content' } | { view: 'settings' } | { view: 'search' }`.
  - `content` (default) — folder contents central; no filters, no side panels (FR-014,
    FR-015, SC-004).
  - `settings` — the `SpaceSettings` sub-view hosting the 001 management panels.
  - `search` — search + content-aware filters revealed on demand (FR-017).
- **Filter availability** (derived, not stored): filters render only when the catalog has ≥1
  material and returned facet vocabulary is non-empty. Empty space → no filter controls.

## 5. Secondary management surface (composition, not data)

`SpaceSettings` re-parents the existing components with **no shape change**:
`MemberList`, `InvitationPanel`, `DriveConnectionPanel`, `TeamAuditPanel`. Visibility of each
follows the existing permission gates (`can('manage_members')`, owner-only drive, owner/admin
audit) — FR-016, FR-020. No new permission or role is introduced.

## Relationships & invariants

- Exactly one of {lobby, wizard, shell} renders at `/team`, selected by entities 1 and 3.
- The shell renders **iff** `enteredSpace !== null` and its `readiness === 'ready'`; entering a
  `setup_incomplete` card routes to the wizard's folder step instead of the shell.
- The persisted selection is the single source of truth for "which space am I in"; no
  component may re-introduce a `teams[0]` fallback.
- No entity here crosses a trust boundary; all authority (permissions, connection state,
  catalog contents) remains server-derived through 001's contracts.

## Out of scope (explicit)

- No new DB tables/columns/migrations; no RLS/grant/function changes.
- No delete-team state (no backend for it); discard is modelled as resumable setup only.
- No cross-device sync of the entered-space selection (local per device, per Assumptions).
