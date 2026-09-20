# Implementation Plan: One Design System Across Every Screen

**Branch**: `021-design-system-redesign` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/021-design-system-redesign/spec.md`

## Summary

Replace the product's several UI dialects with one system: a semantic token layer, a named
component inventory modelled on Nuxt UI's catalogue, and a screen-by-screen migration that
re-dresses all 15 routes and ~40 overlay surfaces against it.

The approach is layered so nothing is ever half-migrated. The token layer lands first and is
adopted _by the existing stylesheet_ — every current variable is redefined in terms of the
new roles, so unmigrated screens inherit the system without being touched. The inventory is
built next as real components plus a demo route that shows every variant, size and state on
one page. Only then are screens migrated, in groups small enough to ship and review on their
own, each group leaving the product fully working.

Nuxt UI supplies vocabulary, not code: its component list, its `color`/`variant`/`size` prop
model, and its component anatomy. The implementation stays in React with one global
stylesheet and CSS custom properties, as constitution VI requires.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true`, ESM NodeNext; React 19 function
components only.

**Primary Dependencies**: No new runtime dependency. Existing: `react`, `lucide-react`
(icon set), Vite. Nuxt UI / Tailwind / Reka UI are **reference material**, not installs.

**Storage**: N/A — this feature writes no data. It reads `localStorage` only where screens
already do (fold state, theme).

**Testing**: Vitest + Testing Library (jsdom) for component and screen behaviour; the
existing suite must keep passing. Visual verification through the beta stack in Chrome at
five widths in both themes. A token-lint check (a script, run in `verify`) asserts no raw
colour/duration/radius/type value re-enters screen CSS.

**Target Platform**: Web app (Cloudflare Pages) and the same bundle served by the local
agent; Chrome/Safari/Firefox current, macOS and Windows.

**Project Type**: Web application — `apps/web` only. No agent, shared-package or Supabase
change is expected; `packages/shared` is touched only if a state enum needs a name.

**Performance Goals**: 60fps on every animated transition; no transition over 300ms; no
layout-affecting property animated. First render of a migrated screen no slower than today
(the stylesheet must not grow materially — it should shrink as dialects collapse).

**Constraints**: One global stylesheet (`apps/web/src/styles.css` plus the four
`styles/*.css` modules); `className` strings, no CSS-in-JS; theming via CSS custom
properties and `data-theme`; `any` stays out of `src`; behaviour frozen (FR-037).

**Scale/Scope**: 15 routes, 9 auth/system states, ~40 dialogs and overlays, ~170 `.tsx`
files in `apps/web/src`, ~24,000 lines of CSS across five files. Roughly 45 named components
in the inventory, of which ~12 have no Nuxt UI counterpart.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design._

| Principle                                      | Status | How this plan complies                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Type-Safe Contracts                         | PASS   | Variant/size/colour vocabularies are string-literal unions in `components/ui`, not free strings. No `any`. No new boundary crossings, so no new parsers.                                                                                                                                   |
| II. One Source of Truth for Release & Protocol | PASS   | Untouched. No version, protocol or manifest surface is in scope.                                                                                                                                                                                                                           |
| III. Security & Least Privilege                | PASS   | No new capability, no new data read, no new permission. Permission-limited states become _more_ honest (FR-004 of the state checklist), never more permissive.                                                                                                                             |
| IV. Child-Process & Resource Discipline        | PASS   | Untouched — no process, queue or lifecycle code in scope.                                                                                                                                                                                                                                  |
| V. HTTP API & Error Conventions                | PASS   | Untouched. Error _presentation_ is restyled; error codes, mapping and retry semantics are not.                                                                                                                                                                                             |
| VI. Frontend Composition & State Discipline    | PASS   | This is the principle the feature serves. One global stylesheet retained and consolidated; `className` + custom properties retained; context idiom unchanged; no data library, no CSS library. The inventory explicitly extracts the shared patterns the principle says not to copy-paste. |

**Post-Phase-1 re-check**: PASS. The design adds one new component directory
(`components/ui/`), one demo route behind a development-only flag, and one lint script. It
removes far more CSS than it adds. No principle is bent; no entry is needed in Complexity
Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/021-design-system-redesign/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions behind the token and component model
├── data-model.md        # Phase 1 — tokens, components, screens, states as entities
├── quickstart.md        # Phase 1 — how to verify the system and a migrated screen
├── contracts/
│   ├── tokens.md        # The token contract: every name, role and theme value
│   ├── components.md    # The component contract: props, variants, sizes, states
│   └── screens.md       # The screen inventory: every screen, every state
├── checklists/
│   └── requirements.md  # Spec quality checklist (done)
└── tasks.md             # Phase 2 — created by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/src/
├── components/
│   ├── ui.tsx                  # today: Button, IconButton, SegmentedControl, Checkbox,
│   │                           # ProgressBar, Spinner, StatusBadge, Tooltip, Collapse
│   ├── ui/                     # NEW — the inventory, one file per component family
│   │   ├── index.ts            # the public surface; `components/ui.tsx` re-exports from here
│   │   ├── Button.tsx          # solid|outline|soft|subtle|ghost|link × xs..xl × 7 colours
│   │   ├── Badge.tsx           # + Chip
│   │   ├── Alert.tsx
│   │   ├── Card.tsx            # panel/section/surface roles
│   │   ├── Field.tsx           # FormField + Input + InputNumber + Textarea + Select
│   │   ├── Choice.tsx          # Checkbox + RadioGroup + Switch + SegmentedControl
│   │   ├── Overlay.tsx         # Modal + Drawer + Popover + DropdownMenu + ContextMenu
│   │   ├── Feedback.tsx        # Toast + Tooltip + Progress + Skeleton + Empty
│   │   ├── Navigation.tsx      # Tabs + Breadcrumb + Pagination + Link
│   │   └── Table.tsx           # data table row/header/density
│   ├── Modal.tsx               # re-homed onto Overlay
│   └── toast.tsx               # re-homed onto Feedback
├── styles/
│   ├── tokens.css              # NEW — the single token layer (roles, scales, motion)
│   ├── base.css                # NEW — reset, element defaults, focus treatment
│   ├── components.css          # NEW — the inventory's styles, one section per component
│   ├── landing-viewer.css      # existing module, migrated in its screen group
│   ├── team-accounts.css       # existing module, migrated in its screen group
│   ├── team-tasks.css          # existing module, migrated in its screen group
│   └── transcription.css       # existing module, migrated in its screen group
├── styles.css                  # shrinks to screen-level layout as groups migrate
├── dev/
│   └── DesignSystemPage.tsx    # NEW — /design, development-only inventory demo
└── … (screens, unchanged in structure; restyled in place)

scripts/
└── check-design-tokens.mjs     # NEW — fails on raw colour/duration/radius/type in screen CSS

tests/
├── design-tokens.test.ts       # NEW — token completeness, both themes, contrast pairs
├── ui-components.test.tsx      # NEW — variants/sizes/states, focus, disabled, loading
└── … (existing screen tests, updated where they assert on class names)
```

**Structure Decision**: `apps/web` only, and inside it a new `components/ui/` directory plus
three new stylesheet modules. The existing single-stylesheet rule is honoured: `styles.css`
keeps importing everything, and the new files are modules of it, not a parallel system. The
four existing `styles/*.css` modules stay where they are and are migrated with their screens.

## Execution Phases

### Phase A — Foundation (blocks everything) — `tasks.md` phases 1–2, T001–T013

1. **Token layer.** Author `styles/tokens.css`: seven colour roles × the shades a component
   needs × two themes; one type ramp; space, radius, shadow, layer, duration and easing sets.
2. **Adoption by the old world.** Redefine every existing custom property
   (`--color-accent`, `--color-action`, `--text-*`, `--dur-*`, `--ease-*`, …) as an alias of a
   token. Unmigrated screens change appearance only where they were already wrong (e.g. a
   duration over the ceiling snaps to it).
3. **Token lint.** `scripts/check-design-tokens.mjs`, wired into `verify`, so the dialects
   cannot grow back while the migration is still running.
4. **Contrast and theme tests.** `tests/design-tokens.test.ts` asserts every role has both
   themes and that the documented foreground/background pairs meet AA.

### Phase B — Inventory (blocks screen work) — `tasks.md` phase 3, T014–T032 and T156

5. **Components, family by family**, in the order screens need them: Button/Badge/Chip →
   Field/Choice → Card/Alert/Empty/Skeleton → Overlay (Modal/Popover/Dropdown/Drawer) →
   Feedback (Toast/Tooltip/Progress) → Navigation (Tabs/Breadcrumb/Pagination) → Table.
6. **Product-specific components** recorded and brought onto tokens without redesign of
   their behaviour: DropZone, HoneycombField, PowerLever/PowerReadout/PowerThrottle, the CRF
   pixel-gem, JobRow, TranscriptPlayer, TaskProgressScale, LandingGalleryGrid, StorageChip,
   Marked, CodeCell/Countdown, SotyLoader family.
7. **Demo surface.** `/design` route, development-only, showing every component with every
   variant, size and state, in both themes and under reduced motion — the page a regression
   shows up on.
8. **Component tests.** `tests/ui-components.test.tsx` — each component renders each variant
   and size, exposes its accessible name, shows disabled and loading distinctly, and is
   reachable and operable by keyboard.

### Phase C — Screen migration (independent groups, any order after B) — `tasks.md` phases 4–17, T033–T134

Each group: re-dress every screen and state in it, delete the CSS it no longer needs, update
tests that asserted on removed class names, verify at five widths × two themes × reduced
motion, and leave the product shippable.

- **C1 — Entry and system states.** PublicHomePage, LoginPage, legal pages, AuthCallback,
  AuthHandoff, AuthLoadingScreen, AuthRecoveryScreen, BlockedAccountScreen (blocked and
  deleted), ConfigErrorScreen, AskWebsiteForSession, ProfileOnboarding.
- **C2 — Shell and cross-cutting.** Top bar (logo, support chip, environment badge, theme
  toggle, language switch, connection chip, user menu), toasts, modal chrome and backdrop,
  tooltips, the release update notice, the local-app dialog, the feature-lock dialog, empty
  and skeleton patterns, InstantTips.
- **C3 — Tools home and compressor.** HomePage tool grid; App.tsx drop zone, settings panel,
  batch toolbar, job rows, results, image embedding section.
- **C4 — Stitcher and landing optimizer.** StitcherPage, LandingOptimizerPage,
  LandingJobCard, ImageCompareModal.
- **C5 — Transcription.** TranscriptionPage, settings panel, rows, player, text modal,
  export/copy menus, language combobox and doubt, model gate, Gemma consent, translator
  notice, elapsed.
- **C6 — 2FA notebook and landing viewer.** TwoFactorPage, rows, cells, countdown, quick
  code; LandingViewer, tree, grid, source switcher, settings and more menus, refresh control,
  welcome.
- **C7 — Account and admin.** AccountPage, AdminPage (filters, table, metrics, export).
- **C8 — Team: entry and shell.** SpaceLobby, SpaceCard, InvitationList, CreateSpaceWizard,
  WorkspaceShell, SpaceSwitcher, SpaceStatePanel, RealtimeChip, BackgroundWorkChip,
  StorageChip, ConnectStorageFlow, the unavailable-space screen.
- **C9 — Team: explorer.** ExplorerShell, list and grid, folder tree, breadcrumb, sort and
  kind menus, row actions, share button, selection bar, preview pane, trash view, upload
  conflict, folder scope, process panel, compressor dialog.
- **C10 — Team: catalogue and search.** TeamCatalog, search bar, filters, results, row menu,
  metadata editor, provenance panel, folder picker, text editor.
- **C11 — Team: tasks.** TaskSpace board, cards, editor, status and sort controls, date
  field and filter, assignee/account/label filters, agent tags, attachment picker and tile,
  progress scale.
- **C12 — Team: accounts.** AccountSpace, groups, rows, money, labels, marker filter.
- **C13 — Team: settings and members.** SettingsDialog, SpaceSettings and its five tabs,
  SettingsSection, TeamPreferences, RestitchDefaults, TaskLabelsSection, MemberList,
  InvitationPanel, permissions and ownership dialogs, audit panel, Drive connection.
- **C14 — Team: media and processing.** MaterialPreview, PreviewUnavailable,
  LandingPreviewFrame, LandingFullView, LandingViewerControls, MaterialProcessFlow,
  OperationStatus, ProcessMaterialDialog, BulkUploadDialog, ProcessLibraryDialog, share
  actions, video text actions.

### Phase D — Close-out — `tasks.md` phases 18–21, T135–T155 and T157–T160

9. **Sweep.** Delete the dialect CSS left orphaned by C1–C14; confirm the token lint passes
   with zero exemptions; confirm `styles.css` has shrunk.
10. **Whole-product pass.** Every screen at 1920/1440/1024/768/390 × dark/light × reduced
    motion, with Ukrainian strings; contrast audit; keyboard-only walkthrough.
11. **Documentation.** `docs/DESIGN-PRINCIPLES.md` gains the inventory and token reference; the
    contributor path is "read this, use these".

## Risks and mitigations

| Risk                                                                                                | Mitigation                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A 24,000-line stylesheet hides couplings; changing a shared class breaks a screen nobody looked at. | Phase A changes _definitions_, not selectors. Screens are migrated in groups, each verified in the running beta before the next starts.      |
| Tests assert on class names the redesign removes.                                                   | FR-038: such tests are rewritten to assert behaviour through roles and accessible names, in the same commit as the screen.                   |
| "While I'm here" behaviour fixes creep into redesign commits.                                       | FR-037 freezes behaviour; findings go into `findings.md` for separate work.                                                                  |
| The demo route ships to production.                                                                 | Development-only guard, same mechanism the existing dev-only surfaces use; verified in the build output.                                     |
| Density loss — Nuxt UI's defaults are roomier than this product needs.                              | The size scale is used (xs/sm for dense tables and chips), never new values; the accounts table and explorer grid are the density reference. |
| Reduced-motion regressions creep back.                                                              | One media query in `tokens.css` neutralises durations globally, so a new transition inherits the behaviour rather than opting into it.       |

## Complexity Tracking

_No constitution violations. Table intentionally empty._
