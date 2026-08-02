# Contract: Navigation & Space Lobby

Covers FR-001…FR-007, SC-003.

## Entry point (FR-001)

- The `HomePage` Team Space launcher card navigates to `/team`. It is a prominent, labelled,
  keyboard-operable control (`role="button"`, Enter/Space activate). It is the single canonical
  entry; the header `UserMenu` "/team" link may remain as a secondary path.
- **Contract**: from the home screen, one activation of the entry reaches the `/team` resolver.

## `/team` resolution (FR-002, FR-004)

`ProtectedWishly` maps `/team` to `<TeamSpace/>`, which renders exactly one surface:

| Condition | Rendered surface |
| --- | --- |
| `enteredSpace === null` and `teams.length > 0` | **Lobby** (space picker) |
| `enteredSpace === null` and `teams.length === 0` | **Lobby empty state** → create |
| `enteredSpace !== null` and `readiness === 'ready'` | **Workspace shell** |
| a `setup_incomplete` card is chosen | **Create wizard** at the folder step |

- **Cache skip (FR-004, SC-003)**: when a valid selection is persisted, opening `/team` renders
  the workspace shell directly, with no lobby in between — exactly one action (opening the
  feature).

## Lobby contents (FR-002, FR-006)

- Renders the user's teams as simple cards (name, role, readiness state) plus a single
  "Create a new space" action. No management panels, audit, or filters appear here.
- `readiness` states per card (see data-model §2): `ready` (enterable), `setup_incomplete`
  ("Continue setup", owner only), `preparing` ("Space is being set up", read-only).
- Empty state (no teams): a welcoming message whose primary action starts the create wizard —
  no list, no panels.

## Selecting / entering (FR-003)

- Activating a `ready` card calls `enterSpace(id)`: persists the selection and renders that
  space's workspace shell. `trackTeamWorkspaceSession()` fires once per entered space (existing
  behaviour, reused).
- Activating a `setup_incomplete` card resumes the create wizard at the folder step for that
  team.

## Change space (FR-005)

- The workspace shell header exposes an always-available "Change space" control.
- Activating it calls `leaveSpace()`: clears the persisted selection and renders the lobby.
  The next selection is persisted anew.

## Invalid / lost selection (FR-007)

- On load, a persisted id not present in `teams` is cleared and the lobby is shown — no error
  screen.
- Realtime membership loss / space deletion clears the entered space and returns to the lobby
  (reuses the existing `onMembershipLost` path in `TeamContext`).

## Acceptance mapping

- US1 scenarios 1–6 map to: entry (1), lobby list (2), enter (3), cache skip (4), change space
  (5), empty state (6).
