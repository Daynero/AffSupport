# Phase 0 Research: Спрощений покроковий інтерфейс командного простору

This feature is a **frontend re-composition** of `001-team-media-workspace`. Research here
resolves the design decisions the spec leaves open, grounded in the current web code. There
are no `NEEDS CLARIFICATION` markers in the spec; each open UX decision is resolved below.

## Current-state findings (grounding)

- `ProtectedWishly.tsx` mounts `<TeamProvider client={teamApi}>` once and maps the exact path
  `/team` to `<TeamWorkspacePage/>`. Routing is hand-rolled and matches exact path strings.
- `TeamContext.tsx` persists the active team in `localStorage['wishly.active-team.v1']` and
  derives `activeTeam = teams.find(id) ?? teams[0] ?? null`. The `?? teams[0]` fallback means
  the app **auto-enters** the first team — there is no "no space chosen yet" state.
- `TeamWorkspacePage.tsx` renders everything at once in a two-column grid: `MemberList`,
  `InvitationPanel`, owner-only `DriveConnectionPanel`, `TeamAuditPanel`, plus `TeamCatalog`
  (search + filters) and `MaterialBrowser`. The header has a raw `<select>` `TeamSwitcher` and
  a Create button.
- `CreateTeamDialog.tsx` is a single-field (name) modal; it calls `teamApi.createTeam(name)`.
- Drive connection is a self-contained multi-step flow already: `startDriveOAuth` →
  `listFolders('root')` → `confirmDriveRoot(confirmed:false)` → `confirmation_required` →
  `confirmDriveRoot(confirmed:true)` → `connected`. All of it lives in `DriveConnectionPanel`
  and the `teamApi` wrappers, and is reusable as the wizard's folder step.
- `TeamCatalog.tsx` always renders `CatalogSearchBar` + `CatalogFilters` regardless of whether
  the space has any materials.
- `teamApi` exposes `listTeams`, `createTeam`, the full drive-connect set, `listMaterials`,
  `searchCatalog`, `getCatalogVocabulary`, members/invitations/audit — **all already present**.
  There is **no** delete-team RPC.
- Analytics events are a typed union in `@video-compressor/shared`; the app already emits
  `team_onboarding_started/completed` and `trackTeamWorkspaceSession()`.

## Decision 1 — Route topology: one `/team` resolver with internal view state

**Decision**: Keep a single `/team` route. Introduce a `TeamSpace` resolver component that
renders exactly one of three surfaces based on `TeamContext` state: **lobby** (no entered
space), **create wizard** (user chose "create" or is resuming an incomplete setup), or
**workspace shell** (a space is entered). The create wizard and space-settings surface are
in-route view states, not new URL paths.

**Rationale**: The spec's core rules are about *state*, not URLs — a cached choice skips the
lobby, "Change space" returns to it. The hand-rolled router matches exact path strings and all
in-app pages share one lazy chunk, so introducing prefix-matched sub-routes would touch the
router core and the view-transition path for no spec-required benefit (there is no deep-link-
to-space requirement). A single resolver keeps the change inside `apps/web/src/team/**`.

**Alternatives considered**: (a) Sub-routes `/team`, `/team/new`, `/team/:id` — gives native
back-button semantics and deep-linking but requires router prefix-matching changes and encodes
the active space in the URL, duplicating the cached-selection source of truth. Deferred as a
possible later enhancement. (b) Modal-based create over the current page — rejected because it
preserves the overloaded page underneath, contradicting the "spacious" intent.

## Decision 2 — Entered-space state replaces the passive auto-select

**Decision**: In `TeamContext`, replace `activeTeam = find ?? teams[0]` with an explicit,
nullable **entered space**: `activeTeamId` is the persisted confirmed choice with **no
`teams[0]` fallback**. Add `enterSpace(id)` (validate membership, persist) and `leaveSpace()`
(clear selection → lobby). On load, if the persisted id is not among `teams`, clear it and
show the lobby. The lobby renders whenever `activeTeamId` is null or unresolved.

**Rationale**: The `?? teams[0]` fallback is precisely what removes the "choose a space first"
step (FR-002) and what a returning user's cache must be able to *not* satisfy after "Change
space" (FR-005). Making "no confirmed choice" a real state is the smallest change that yields
the whole navigation behaviour, and it keeps one source of truth for the active space (Prin.
VI). Realtime membership-loss already clears the active team; that path now naturally returns
the user to the lobby (FR-007, edge case: deleted/lost space).

**Alternatives considered**: A separate `showLobby` boolean beside the existing fallback —
rejected: two sources of truth for "which space am I in", prone to auto-enter races.

## Decision 3 — Create wizard: create team at the folder step; classify folderless teams as setup-incomplete

**Decision**: The wizard is linear with one primary action per step:

1. **Name** (required) — local input; on "Continue", validate and call `teamApi.createTeam`.
   The team row is created **here** (because the folder step needs a `teamId`).
2. **Connect folder** (required) — run the existing drive-connect sub-flow for that `teamId`.
   The wizard cannot finish until a root is `connected`.
3. **Done** — `enterSpace(newTeamId)`; land in the workspace shell showing the folder.

Any team that exists but has never had a root connected (`connectionState` in
`none|pending|detached|needs_reauth` with no successful root) is presented in the lobby as a
**"Continue setup"** card, not as a ready space. Selecting it re-enters the wizard at the
folder step. Ready spaces (root connected) appear as normal, enterable cards.

**Rationale**: `create_team` persists immediately and there is no delete-team RPC, so a space
cannot be materialised atomically only after both inputs. Creating at the folder step
minimises empty rows (bailing on the name step creates nothing), and the setup-incomplete
classification means an abandoned or interrupted setup is **never presented as a usable
space** (FR-012, SC-007) while remaining resumable — all frontend-only. The same classifier
elegantly covers two spec cases for free: pre-existing folderless teams from 001, and an
invited member opening a space whose owner has not finished folder connection ("space is being
set up"). Production Drive gating (`OAUTH_APPROVAL_REQUIRED`) is shown at the folder step and
blocks completion with a plain-language explanation (FR-013).

**Alternatives considered**: (a) Create the team only after the folder is chosen — impossible,
the folder connect calls require an existing `teamId`. (b) Add a delete-team RPC to hard-
discard abandoned setups — rejected: breaks frontend-only scope and opens new SQL/RLS surface;
recorded instead as an explicit follow-up. (c) Collect the folder in the same step as the name
— rejected: violates "one primary action per step" and mixes an OAuth redirect into a text
field.

## Decision 4 — Progressive disclosure: content-first shell + one "Space settings" surface

**Decision**: The workspace shell shows the connected folder's contents (`MaterialBrowser`) as
the central, default element. The header carries only: the space name, a **Change space**
control, a **Space settings** entry, and (when there is content) a search/filter toggle. The
001 management components — `MemberList`, `InvitationPanel`, `DriveConnectionPanel`,
`TeamAuditPanel` — move, unchanged, into a single **`SpaceSettings`** surface (a dedicated
in-route sub-view) opened from the header. Each panel remains permission-gated exactly as
today (FR-016, FR-019, FR-020).

**Rationale**: This directly answers "everything in one overloaded window". A dedicated
settings sub-view (rather than a cramped drawer or stacked modals) reads cleanly on narrow
screens and avoids modal-in-modal with the drive folder browser. Re-parenting rather than
rewriting keeps all 001 behaviour and tests substantially intact.

**Alternatives considered**: Slide-over drawer (viable, noted as an acceptable alternative but
tighter on small screens); tabs inside the workspace (rejected — reintroduces many
simultaneous controls, the exact complaint).

## Decision 5 — Search and filters are hidden by default and content-aware

**Decision**: `TeamCatalog` no longer renders `CatalogSearchBar`/`CatalogFilters` on mount.
Search is behind a toggle in the shell header; filters render **only** when the catalog has ≥1
material and the returned facet vocabulary is non-empty. An empty space shows neither (FR-015,
FR-017, SC-004). The underlying `useCatalogSearch` hook and search RPC are unchanged.

**Rationale**: Satisfies "no junk filters, none until there's content" while preserving full
search capability on demand. Facet availability is already returned by
`getCatalogVocabulary`/`searchCatalog`, so "meaningful filters only" is derivable without new
backend data.

**Alternatives considered**: Always-visible search with disabled filters — rejected: still
shows controls with nothing to act on. Removing filters entirely for v1 — rejected: loses
capability the spec wants merely *hidden*, not deleted (FR-019).

## Decision 6 — Home entry stays and is made unmistakable

**Decision**: Retain the existing `HomePage` launcher card that navigates to `/team`; ensure
it is a prominent, clearly labelled, keyboard-operable entry (it already is a `role="button"`
card). `/team` now resolves to lobby-or-workspace, so the same entry serves first-time and
returning users (FR-001).

**Rationale**: The entry exists; the spec's concern is discoverability and that it leads into a
sensible flow rather than the overloaded page. Keeping one canonical entry avoids duplicate
navigation paths. `UserMenu` already offers a secondary `/team` link and can remain.

**Alternatives considered**: A new top-nav item — deferred; unnecessary given the prominent
home card and the shared header's existing menu link.

## Decision 7 — Analytics: reuse existing events; add at most one, in shared

**Decision**: Reuse `team_onboarding_started/completed` for the create wizard and
`trackTeamWorkspaceSession()` on entering a space. Only if lobby/selection funnel measurement
(SC-001/SC-002/SC-003 instrumentation) needs it, add a single new event **name to the shared
`TeamAnalyticsEventName` union** with typed props, never a string literal in the app.

**Rationale**: Keeps Principle II intact (shared is the source of truth for event names) and
avoids scope creep. The success criteria are validated primarily by moderated tests and DOM
tests, so heavy new telemetry is not required.

## Testing approach

DOM tests (`jsdom` docblock) in `tests/*.test.tsx`, driving the surfaces through
`TeamContextOverride` and injected `client` stubs (the established pattern). Focus: lobby
resolution and cache skip, "Change space" returns to lobby, wizard name/folder gating and
resume-of-incomplete, empty-space zero-filters/zero-panels, settings reachability + permission
gating, and invalid-cache fallback. No DB/Edge tests are needed because no backend changes.

## Resolved unknowns

- Route model → single `/team` resolver with view state (Decision 1).
- "No space chosen" representation → nullable entered-space, drop `teams[0]` fallback (Dec. 2).
- Required-folder vs immediate team creation → create at folder step + setup-incomplete lobby
  classification; no delete-team backend (Decision 3).
- Where the 001 panels go → one `SpaceSettings` sub-view (Decision 4).
- Filter suppression rule → hidden by default, shown only with content/facets (Decision 5).
- Home entry → retained and prominent (Decision 6).
- Telemetry → reuse existing; at most one shared event (Decision 7).
