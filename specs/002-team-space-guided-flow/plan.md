# Implementation Plan: Спрощений покроковий інтерфейс командного простору

**Branch**: `main` _(Spec Kit feature: `002-team-space-guided-flow`)_ | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-team-space-guided-flow/spec.md`

## Summary

This feature re-composes the **presentation and navigation** of the existing team media
workspace (`001-team-media-workspace`) into a guided, progressively disclosed experience for
non-technical users. No server capability is added: every RPC, Edge Function, table, and
shared contract from 001 is reused unchanged. The work lives almost entirely in
`apps/web/src/team/**`, plus the home-screen entry, the `/team` route resolution in
`ProtectedSoty.tsx`, new compile-checked i18n keys, and DOM tests.

Three surfaces replace the single overloaded `TeamWorkspacePage` grid:

1. **Space lobby** — the `/team` entry resolves to a plain space picker when no space is
   actively selected: the user's teams as simple cards plus "Create a new space". Selecting a
   space _enters_ it and persists that choice; a later visit skips the lobby and opens the
   entered space directly. A "Change space" control in the workspace returns to the lobby.
2. **Create-space wizard** — a linear, one-primary-action-per-step flow: enter name
   (required) → connect one Google Drive folder (required) → land in the new space. A space
   whose folder was never connected is presented as "finish setup", never as a ready space.
3. **Decluttered workspace shell** — the connected folder's contents are the central,
   default view. Members, invitations, drive settings, roles, and audit move behind one
   clearly labelled "Space settings" surface. Search and filters are hidden by default and
   surfaced on demand, with filter controls shown only when there is content to filter.

The key state change is in `TeamContext`: the passive `activeTeamId ?? teams[0]` auto-select
is replaced by an explicit, nullable _entered space_ selection, so "no confirmed choice" is a
first-class state that renders the lobby (FR-002, FR-004, FR-005, FR-007).

The one reconciliation the design must own: `create_team` persists a team row before a folder
can be attached (drive-connect actions require a `teamId`), and 001 exposes no delete-team
RPC. Rather than add backend, the wizard creates the team row only when the user commits the
name and advances to the folder step, and the lobby classifies any team without a connected
root as **setup-incomplete** (a "Continue setup" card that resumes the wizard), not as a
usable space. This satisfies "no half-created space presented as ready" (FR-012, SC-007)
frontend-only and simultaneously handles pre-existing folderless teams from 001 and the
"invited member sees a space still being set up" edge case.

## Technical Context

**Language/Version**: TypeScript 5.9.3, `strict: true`, ESM (`NodeNext`, ES2022); React
19.2.7 function components with the existing hand-rolled routing and context idioms. No new
language or runtime surface.

**Primary Dependencies**: Existing web stack only — Vite, the typed `teamApi`
(`apps/web/src/api/team.ts`), `TeamContext`, `useI18n`, `usePageEntrance`/`navigateTo`
(`apps/web/src/lib/navigation.ts`), the `components/ui` + `components/Modal` primitives, and
the existing drive-connect / catalog / preview / processing components under
`apps/web/src/team/**`. No new client dependency; no new data-fetching library.

**Storage**: No database or Edge change. The only persisted client state is the existing
`localStorage` key `soty.active-team.v1`, whose semantics change from "last auto-selected"
to "explicitly entered space" (nullable; cleared on "Change space" and on invalid/missing
selection). All authoritative data continues to come from 001's RPC/Edge surface.

**Testing**: Vitest with the `// @vitest-environment jsdom` docblock, in the central
`tests/` directory as `*.test.tsx`, using `TeamContextOverride` and injected client stubs
(the same pattern as `tests/team-workspace.test.tsx`, `tests/team-members.test.tsx`).
Coverage: lobby resolution + cache, wizard step gating + required-folder + resume-setup,
decluttered default shell (zero filters / zero side panels on an empty space), secondary
surface reachability, permission gating, and invalid-cache fallback.

**Target Platform**: Cloudflare Pages web app only. No agent, Supabase, or release/deploy
work is in scope for this feature.

**Project Type**: Existing npm-workspaces monorepo; changes are confined to `apps/web`
(with i18n keys, and — only if a new analytics event is introduced — a contract addition in
`@video-compressor/shared`, see Constitution Check II).

**Performance Goals**: Interaction-level, not throughput. Entering a space from a saved
selection reaches the workspace in exactly one action (SC-003-analogue SC-003 here). Route/
view swaps reuse the existing view-transition path and `page-enter` animation; no new polling
or fetch loop is introduced (the workspace still reads authoritative rows through the current
`teamApi` calls and Realtime refetch in `TeamContext`).

**Constraints**:

- Reuse-only backend: no new/changed RPC, Edge Function, table, RLS policy, or migration.
  The production Drive OAuth gating from 001 (`OAUTH_APPROVAL_REQUIRED`, closed by default)
  is surfaced verbatim inside the wizard's folder step, never bypassed (FR-013).
- Required-folder is enforced as a wizard gate for **new** creation only; pre-existing
  folderless teams remain usable and are prompted (not blocked) to connect a folder.
- No delete-team capability exists in 001; "discard an abandoned setup" is therefore modelled
  as resumable "Continue setup", and true deletion is called out as an explicit follow-up,
  not silently assumed.
- Keep the tree `any`-free; read i18n through `useI18n` with new compile-checked
  `TranslationKey`s added to both `en` and `uk`; permission gating stays authoritative via
  `can()` / `activeTeam.permissions` (FR-020).
- Accessibility: keyboard operability, visible focus, labelled controls, and no horizontal
  scroll of primary content on narrow/zoomed viewports for the lobby, wizard, and shell
  (FR-021).

**Scale/Scope**: 3 user stories, FR-001…FR-021, SC-001…SC-008. Bounded by the existing
per-team limits from 001 (≤50 members, ≤50,000 catalog rows). No change to those limits, to
billing, or to any 001 out-of-scope item.

## Constitution Check

_GATE: evaluated before research and re-checked against the Phase 1 design below._

| Principle                                    | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Post-design verdict    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| **I. Type-safe contracts**                   | New client state (entered-space selection, lobby-item readiness, wizard step machine) is modelled as string-literal unions and discriminated results; the persisted `activeTeamId` is validated (UUID shape) on read as it is today; no `as`-casting of untrusted data; internal ESM imports keep `.js`. Reuses the already-typed `TeamContextSnapshot` / `DriveRootResult` / `TeamApiError`.                                                                                                                                                                                              | **PASS**               |
| **II. One source of truth**                  | No release/protocol/version change. If a lobby/selection analytics event is added, its name joins `TeamAnalyticsEventName` in `@video-compressor/shared` (not hard-coded in the app) and follows the existing typed-props discipline; otherwise existing `team_onboarding_*` / workspace-session events are reused. No duplicated constants.                                                                                                                                                                                                                                               | **PASS**               |
| **III. Security/least privilege**            | Purely presentational re-composition. No new data path, grant, token, or Drive scope. Permission-gated controls stay gated by the server-derived `permissions`; the client never widens access. Production Drive gating is displayed, not circumvented.                                                                                                                                                                                                                                                                                                                                    | **PASS (N/A surface)** |
| **IV. Child-process/resource orchestration** | No agent or child-process code touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **PASS (N/A)**         |
| **V. HTTP/error conventions**                | No new endpoint. The wizard and lobby surface existing stable `TeamApiError` codes (`OAUTH_APPROVAL_REQUIRED`, `NAME_CONFLICT`, `DRIVE_UNAVAILABLE`, …) through i18n, branching on the code, not on message text.                                                                                                                                                                                                                                                                                                                                                                          | **PASS**               |
| **VI. Frontend composition/state**           | Entered-space selection and readiness live in the existing throwing `useTeam()` context with its `TeamContextOverride` test seam; no new global store. Backend calls stay in the typed `teamApi` wrappers; no new call is added. No polling, no prop-drilled `t`, no inline static styles (new layout uses `className` against `styles.css` + CSS custom properties), no new `any`. Large files are split, not grown: the current `TeamWorkspacePage` is decomposed into `SpaceLobby`, `CreateSpaceWizard`, `WorkspaceShell`, and a `SpaceSettings` surface rather than extended in place. | **PASS**               |

Additional gates: local gates are `format:check`, `lint`, `test`, and `build -w @video-compressor/web`; new tests live in `tests/*.test.tsx` with the jsdom docblock; i18n stays a compile-checked union across `en`/`uk`. No migration, DB type regen, or `test:db` run is required because no SQL changes.

**Result: PASS. No unresolved `NEEDS CLARIFICATION`, no unjustified violation. The single
architectural reconciliation (create-then-mark-incomplete instead of a new delete path) is
recorded in Complexity Tracking as a reuse-preserving choice, not added complexity.**

## Project Structure

### Documentation (this feature)

```text
specs/002-team-space-guided-flow/
├── plan.md                 # This file
├── research.md             # Phase 0 — routing/state/wizard/disclosure decisions
├── data-model.md           # Phase 1 — client state entities & transitions (no DB)
├── quickstart.md           # Phase 1 — validation scenarios mapped to SC-001…SC-008
├── contracts/
│   ├── README.md
│   ├── navigation-and-lobby.md
│   ├── create-space-wizard.md
│   ├── workspace-shell-and-disclosure.md
│   └── reused-backend.md
├── checklists/requirements.md
└── tasks.md                # Phase 2 — created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
apps/web/src/team/
├── TeamContext.tsx                 # CHANGE: entered-space selection (drop `?? teams[0]`
│                                   #   fallback); enterSpace()/leaveSpace(); invalid-cache clear
├── TeamSpace.tsx                   # NEW: top-level resolver for /team — lobby | wizard | shell
├── lobby/
│   ├── SpaceLobby.tsx              # NEW: space cards + "Create new space" + empty state
│   └── SpaceCard.tsx               # NEW: ready | setup-incomplete | preparing card states
├── create/
│   ├── CreateSpaceWizard.tsx       # NEW: linear step machine (name → folder → done)
│   ├── SpaceNameStep.tsx           # NEW: required-name step (reuses create_team on advance)
│   └── ConnectFolderStep.tsx       # NEW: wraps the existing drive-connect sub-flow, required
├── workspace/
│   ├── WorkspaceShell.tsx          # NEW: content-first shell + header (change space, settings)
│   └── SpaceSettings.tsx           # NEW: secondary surface hosting the 001 management panels
├── TeamSwitcher.tsx                # REMOVE/replace: raw <select> superseded by lobby + change-space
├── CreateTeamDialog.tsx            # REMOVE/fold: single-field dialog superseded by the wizard
├── members/ | drive/ | preview/ | processing/   # REUSED as-is (re-parented under SpaceSettings)
└── catalog/
    ├── TeamCatalog.tsx             # CHANGE: search/filters hidden by default, content-first
    └── CatalogFilters.tsx          # CHANGE: render only when facets/content make filters meaningful

apps/web/src/
├── ProtectedSoty.tsx             # CHANGE: `/team` → <TeamSpace/> (was <TeamWorkspacePage/>)
├── HomePage.tsx                    # CHANGE: keep/elevate the prominent Team Space entry card
├── i18n.ts                         # CHANGE: add lobby/wizard/settings keys to en + uk unions
└── analytics/ (events.ts,service.ts) # OPTIONAL: reuse onboarding events; add one only if needed

packages/shared/src/team/analytics.ts # OPTIONAL: only if a new lobby/selection event name is added

tests/
├── team-space-lobby.test.tsx       # NEW: entry → lobby, select → enter, cache skip, change-space
├── team-space-cache.test.tsx       # NEW: saved selection opens workspace; invalid selection → lobby
├── create-space-wizard.test.tsx    # NEW: name required, folder required, resume incomplete setup
├── workspace-shell.test.tsx        # NEW: empty space shows zero filters / zero side panels
├── space-settings.test.tsx         # NEW: all 001 panels reachable + permission-gated
└── team-workspace.test.tsx         # UPDATE: existing test migrated to the new shell composition
```

**Structure Decision**: Decompose the single `TeamWorkspacePage` into a `/team` resolver
(`TeamSpace`) that renders one of three composed surfaces (lobby, wizard, shell) driven by the
entered-space state in `TeamContext`. All 001 management components are re-parented, not
rewritten, under a `SpaceSettings` surface; the catalog is re-composed for progressive
disclosure. Backend, agent, and shared contracts are reused unchanged (the only possible
shared touch is one optional analytics event name).

## Complexity Tracking

No constitution violation requires a waiver. The one non-obvious choice — creating the team
row at the wizard's folder step and classifying any folderless team as _setup-incomplete_
rather than adding a delete-team backend path — is a reuse-preserving decision: it keeps this
feature frontend-only (Principle VI), avoids new SQL/RLS surface (Principle III), and reuses
001's existing `create_team` + `drive-connect` contract exactly. True space deletion is
recorded as an explicit follow-up, not silently assumed.

| Reconciliation                                                                  | Why needed                                                                | Simpler alternative rejected because                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create team at folder step + "setup-incomplete" lobby card (no delete)          | `drive-connect` needs a `teamId`; 001 has no delete-team RPC              | Deferring team creation until both steps done is impossible (folder connect requires the team to exist); adding a delete-team RPC would break the frontend-only scope and open new SQL/RLS surface |
| Replace passive `activeTeamId ?? teams[0]` with explicit nullable entered-space | The `?? teams[0]` fallback is exactly what defeats "show the lobby first" | Keeping the fallback and layering a separate "show lobby" flag would create two sources of truth for the active space and reintroduce auto-enter races                                             |
