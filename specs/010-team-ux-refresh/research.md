# Phase 0 Research — Team Mode UX Refresh

All unknowns from the plan's Technical Context are resolved below. Every decision was grounded
by reading the current implementation during planning (files cited inline); none require
further clarification. Finding IDs (N1…P3) refer to `findings.md`.

---

## D1. Section routing on the hand-rolled router

**Decision**: Extend the existing navigation seam, no router library. `ProtectedSoty.tsx`
changes its exact `path === '/team'` match to a `/team` prefix match and passes the full route
into `TeamSpace`. A new `team/routes.ts` owns parsing/building:

- `/team` — resolver (lobby / direct entry / wizard resume as today)
- `/team/<spaceId>` — workspace, Files section (canonical default, no `/files` suffix)
- `/team/<spaceId>/tasks | creatives | landings | settings | trash` — sections
- Query state: `?q=&filters…` (Files search), `?task=<id>` (open task editor), existing
  `?drive=…` OAuth return preserved at `/team` level.

Tabs render as real `<a>` elements using `internalLink()` + `aria-current="page"`, so
middle-click, copy-link, Back/Forward and view transitions all come for free
(`lib/navigation.ts:85-118`). Entering a space = `navigateTo('/team/<id>')`; the
`localStorage` remembered space only decides the *redirect target* when landing on bare
`/team`; the URL always wins over the cache. Unknown space id or RLS denial → neutral
"no access" screen (same copy for "doesn't exist" and "not yours"), satisfying 001 FR-016.

**Rationale**: Constitution VI forbids adding a router; the seam (`useBrowserRoute` +
`navigateTo` + popstate/view transitions) already exists and is how every other page works.
URL-as-truth fixes N2 (refresh/back/deep links) with the least novel machinery.

**Alternatives considered**: (a) react-router — rejected: violates constitution VI and the
one-lazy-chunk transition design in `navigation.ts:36-42`; (b) sessionStorage view
persistence without URLs — rejected: fixes refresh but not Back, not links, not SC-003;
(c) hash-based sub-routing — rejected: uglier links, no benefit over pathname on a SPA host
that already rewrites to index.

## D2. One notification mechanism (toasts) + error humanization

**Decision**: New `components/toast.tsx` — `ToastProvider` + `useToasts()` in the mandated
context idiom (`createContext<T | null>`, throwing hook, `XContextOverride` for tests).
API: `push({ tone: 'success' | 'error' | 'info', text, action?: { label, run }, sticky? })`;
renders an `aria-live="polite"` stack; auto-dismiss except `sticky`; action button powers
Undo (D8) and Retry. Team mode adopts it everywhere (S1, S7, S8); the compressor page's local
`addToast` (`App.tsx:132-138`) is left alone in this feature (migration to the shared provider
is a follow-up, not scope).

Error copy: a single `teamErrorMessage(code, t): string` helper in `team/` maps every
`TeamErrorCode` to a `TranslationKey` (with a generic fallback for unknown codes). Machine
codes stay the API contract (constitution V); humanization happens only at render (FR-014).
`MaterialActions.errorMessage`'s raw `Error.message` passthrough (S1) is deleted in favor of
this helper.

**Rationale**: Constitution VI explicitly calls the copy-pasted SSE+toast boilerplate an
anti-pattern to stop copying — a shared provider is the sanctioned shape. One mapper keeps
FR-013/FR-014 testable in a single place.

**Alternatives considered**: (a) a toast library — forbidden dependency; (b) per-surface
inline error paragraphs (status quo) — fails FR-013's "single mechanism" and leaves silent
paths; (c) global window event bus — weaker typing, breaks the context idiom.

## D3. "Space has content" signal for search availability

**Decision**: Derive search/filter availability from the space-wide freshness envelope the
shell already fetches: `catalogFreshness.discoveredCount > 0 || total > 0` from the
`pageSize: 1` probe in `useCatalogFreshness` (`catalog-search.ts:96-117` — `discoveredCount`
is explicitly documented as the unfiltered space-wide liveness count). `WorkspaceShell` stops
deriving `hasContent` from the current folder's row count (F1) and passes the space-level flag
down. File actions are never gated by this flag (FR-007); only the search box/filters honor
the "truly empty space stays clean" rule (FR-008).

**Rationale**: Zero new backend; the probe already runs on every revision tick; semantics
match the spec exactly ("вміст будь-де в підключеній папці").

**Alternatives considered**: (a) new `count_team_materials` RPC — needless round trip;
(b) keep folder-count gating but also probe root recursively — complex and still wrong for
folder-only roots.

## D4. File actions in the Files browser + shared folder picker

**Decision**: `MaterialActions` is split into (1) a headless `useMaterialActions` hook
(operation calls, busy/error state, idempotency keys — the existing transport logic) and
(2) a lazy `MaterialRowMenu` rendered only when opened (fixes P1: no more 50 mounted
instances). `MaterialBrowser` rows gain the full permission-shaped action set (FR-007);
`MaterialResults` (search) reuses the same menu. The browser passes its current folder as
`destinationFolderId`, which also revives the dead "Upload new version" and conflict-replace
branches (F6) — wire them, do not delete.

Destination selection: new `catalog/FolderPicker.tsx` — a Modal navigating **catalog
folders** via the existing `listMaterials(teamId, parentFolderId)` filtered to
`kind === 'folder'` (the same data the browser tree uses), with breadcrumb + "Select current
folder", mirroring the wizard's Drive browser UX. It replaces all three raw-ID inputs (F4):
move, process output, save-text-as-new-version. Drive-side `listFolders` (OAuth wizard path)
is *not* reused here — it lists Drive-wide folders, not the connected root's catalog.

**Rationale**: Reuses proven data paths; kills the largest click-path regression (F2) and the
raw-ID inputs in one shared component; lazy menus are the direct fix for SC-009.

**Alternatives considered**: (a) reuse `TaskAttachmentPicker` for destinations — it selects
*files* for attachment, wrong selection model; extract only its navigation pattern;
(b) keep `<details>` rows but mount lazily — still two systems (browser vs search) and no
picker; (c) full virtualized list — out of scope, 50-cap pages suffice for SC-009.

## D5. Trash view + undo

**Decision**: The catalog already tracks `lifecycle: 'active' | 'trashed' | 'missing'`
(`supabase/functions/drive-ops/handler.ts:38`) and `drive-ops/restore` exists
(`api/team.ts:1636`). Add one read: `list_team_trashed_materials(p_team, p_limit, p_before)`
(security definer, view-permission check, newest-first) + `teamApi.listTrashedMaterials`.
UI: trash lives at `/team/<id>/trash` (reachable from the Files toolbar), rows offer Restore
(and show the honest Drive-retention note, FR-025). Trashing from any row: no confirm modal
(R3 inversion fix), success toast carries **Undo** → `restoreMaterial` with the same
idempotency-key discipline as other file ops. Undo races (file already restored/purged by
someone else) surface the operation's error code through D2's mapper (edge case in spec).

**Rationale**: All mutation paths already exist server-side; only the listing read is new.
Undo-over-recoverable-trash is the time-tested pattern (Gmail/Drive) the spec chose, and 001's
"deletion must be recoverable via Drive trash" intent is preserved — strengthened, since the
UI finally exposes restore (R2).

**Alternatives considered**: (a) extend `list_team_materials` with a lifecycle param —
touches every existing caller's expectations; a dedicated read is smaller and greppable;
(b) client-side "pending trash" with delayed commit (true undo) — hides truth from other
members during the grace window; rejected as dishonest state.

## D6. Membership lifecycle RPCs

**Decision**: One forward-only migration adding three `security definer` functions
(`set search_path = ''`, fully-qualified, existing helper checks, audit rows):

- `leave_team(p_team)` — self-removal for non-owners; owner gets `OWNER_TRANSFER_REQUIRED`
  (mirrors `remove_member`'s guard at `20260801100000_team_membership_actions.sql:169` but
  authorizes on *self* instead of `manage_members`). Audit: `membership.left`. Same
  `EXTERNAL_DRIVE_ACCESS_REMAINS` warning envelope as `remove_member`.
- `delete_draft_team(p_team)` — owner-only; refuses (`TEAM_NOT_DRAFT`) if the team has *ever*
  had a drive connection row (stricter than UI readiness: `setup_incomplete` shows for
  `none|detached`, but only never-connected teams are deletable — a detached space keeps its
  catalog/history and stays undeletable, per spec Assumptions). Cascade-deletes memberships +
  invitations for the draft. Audit: `team.draft_deleted` (written before the row goes away, or
  kept via the audit table's independence — decided in the migration).
- `delete_team_task(p_team, p_task)` — requires the task-edit permission (005's rule: task
  create/update = `edit`); hard delete of the task row + its attachment links. Audit:
  `task.deleted`. Rationale for hard delete: tasks are lightweight coordination rows (005),
  no artifact provenance hangs off them; an archived state would add a second lifecycle for
  no stated need.

Client wrappers follow the `rpc → throwRpc → guard` pattern; PGlite tests extend the existing
team-contract harness (regenerate via `scripts/generate-team-contract-sql.mjs`); ROLLBACK.md
gets reverse steps; `npm run types:supabase` refreshes DB types.

**Rationale**: Smallest server surface that closes I2/I3/R1; every guard reuses the security
template from 001's membership actions.

**Alternatives considered**: (a) widen `remove_member` to allow self — overloads one function
with two permission models, harder to audit; (b) soft-delete flags for teams/tasks — new
states leaking into every existing read; (c) Edge Function instead of RPC — membership CRUD
is already all-RPC; consistency wins.

## D7. Invitations surfaced where teams live

**Decision**: Extract the account page's `InvitationInbox` (`pages/AccountPage.tsx:240`) into
`team/lobby/InvitationList.tsx` (shared by both surfaces), rendered at the top of the lobby
with accept/decline inline (FR-021); accept → `enterSpace` → `navigateTo('/team/<id>')` (or
show the "preparing" card). The resolver checks `listMyInvitations()` alongside `listTeams()`
— the single-ready-space direct entry (FR-005) only triggers when the invitation list is
empty. The Home entry card shows a badge count from the same call, fetched non-blocking on
mount for signed-in users; failures degrade to no badge (never block Home).

**Rationale**: The API is complete (I1 — `listMyInvitations`/`accept/decline` at
`api/team.ts:1155-1243`); this is purely relocation + reuse, the exact 002 philosophy
("nothing removed, only relocated" — inverted: nothing added, only surfaced).

**Alternatives considered**: (a) full notification center — out of scope by spec; (b) badge
via a new count RPC — `listMyInvitations` is already small and cacheable per entry.

## D8. Background library processing provider

**Decision**: Lift the claim loop out of `ProcessLibraryDialog` (B1: the `for(;;)` at
`:213-348` and the unmount-release at `:206-211`) into `LibraryProcessingProvider` mounted
inside the workspace shell (per entered space), context idiom + test override. The provider
owns: run state (`idle|running|complete|failed|canceled`), per-kind progress, the active
lease (claim → context → heartbeat → agent run → complete), and explicit `cancel()`.
`ProcessLibraryDialog` becomes a **viewer** (start/cancel/retry + progress) over that context;
closing it changes nothing about the run (FR-032). The shell header renders a compact
background-work chip (spinner + n/m) whenever the provider is running, opening the dialog on
click. Leaving the whole `/team` tree or closing the tab unmounts the provider → the current
attempt is released exactly as today, and server-side leases expire and stay reclaimable —
no orphaned work (constitution IV semantics preserved). Completion pushes a summary toast
(successes/failures) even if the dialog is closed.

**Rationale**: Fixes the hostage-window without touching the lease protocol or the agent;
the provider boundary (space-scoped) matches the data's scope and keeps "leave space during
batch" honest (edge case: the run continues while the shell lives; a full exit releases the
lease and the queue survives server-side).

**Alternatives considered**: (a) Web Worker / SharedWorker — heavier, no cross-context typed
Supabase client story, unnecessary for a lease-based queue; (b) keep the dialog mounted
hidden — a lie with real costs (state tied to render tree, focus traps); (c) move
orchestration server-side — out of scope, changes 005's architecture.

## D9. One dialog primitive

**Decision**: Port the seven hand-rolled overlays (C1: `ProcessMaterialDialog`,
`TeamTextEditor`, `MaterialPreview`, `LandingFullView`, and TeamCatalog's operation/
provenance/text-version overlays) onto `components/Modal` (portal, focus trap, Escape,
scroll lock, backdrop, z-100). Wide/immersive surfaces use a size variant (`xl` /
full-bleed class) rather than a second system. `TeamCatalog`'s seven mutually-exclusive
overlay booleans collapse into one discriminated union
`overlay: { kind: 'edit' | 'preview' | 'text' | 'process' | 'operation' | 'provenance' | 'version', … } | null`
so stacking dead-ends become unrepresentable (FR-029). Unsaved-changes guard reuses the
TaskEditor prompt pattern. The stray z-index band (45/80 vs 100) is retired with the ported
components; `styles.css` gains explicit layer tokens.

**Rationale**: `Modal` already implements every behavior FR-029 requires; convergence deletes
code and the entire class of under-modal rendering bugs.

**Alternatives considered**: upgrading the hand-rolled overlays in place (add traps/Escape to
each) — seven times the work of deleting them, and the z-index split survives.

## D10. Tabs, keyboard minimum, and a11y

**Decision**: The section bar is a `<nav>` of links (D1) with `aria-current="page"` — link
semantics, not `role="tablist"` (sections are routes, not in-page panels; arrow-key roving is
explicitly out of scope by spec). Global-per-view shortcuts: `/` focuses the search field when
the active section has one (FR-012), Escape closes whatever Modal is open (comes free from
D9). `TaskDateFilter`'s popover gets Escape/blur close as part of its touch-up. Nothing else —
the spec's Out of Scope defers the full keyboard model.

**Rationale**: Links-as-navigation is the honest semantic once URLs exist and keeps the a11y
surface small; matches "time-tested" over experimental.

**Alternatives considered**: ARIA tabs pattern with roving tabindex — wrong semantics for
route navigation and adds the exact scope the spec deferred.

## D11. Glossary enforcement

**Decision**: The spec's «Термінологія» table becomes `contracts/glossary.md` plus an
executable test `tests/team-i18n-glossary.test.ts` that imports both locale bundles and
asserts: (1) no forbidden tokens in team-facing keys («Таски», «ДОНТ ПУШ», "workspace" as an
object noun in uk copy, матеріал/asset/media synonyms in user-visible team strings, the
placeholder gate title); (2) required canonical labels exist for the five sections; (3) the
Close/Cancel split — keys used by close-only surfaces must not carry the Cancel string
(enforced by a small key-role map in the test). Key *renames* ride the compile-checked
`TranslationKey` union so every call site updates or fails the build. The three duplicate
Cancel keys collapse to `teamCancel` + new `teamClose`.

**Rationale**: A glossary that only lives in a spec rots; the union type + one test makes
SC-007 continuously checkable at zero runtime cost.

**Alternatives considered**: lint rule — heavier to write than a test over the bundles;
manual copy review — exactly what allowed «ДОНТ ПУШ ЗЕ ХОРСИС» to ship (C3).

## D12. Truthful sync + realtime visibility

**Decision**: `SyncProgress` renders `failed` (banner with retry → `resyncDrive`) and
`unavailable` states instead of returning null (S4); the Files view's `syncLabel` prop is
deleted — the banner is the single source (its hardcoded "up to date" contradiction, S4,
disappears). `useCatalogFreshness` gains a poll fallback: when `realtimeState !== 'connected'`
or no revision tick arrived for 60 s during an active scan, refetch on an interval; the
banner therefore cannot freeze (S5). `TeamContext`'s `realtimeState` renders as a small
header chip only in the degraded states (`reconnecting` after a grace period, `disabled`),
with copy "оновлення затримуються" (FR-018). `handleMembershipLost` routes through the toast
(sticky, explanatory) before landing in the lobby (S6, FR-019).

**Rationale**: Every ingredient already exists in state; this is rendering truth that is
currently tracked and discarded.

**Alternatives considered**: always-visible connection indicator — noise in the healthy
state; polling always — wasteful given realtime works most of the time.

## D13. Task draft lifecycle

**Decision**: "Create task" (from cards, selections, or the Tasks header) opens `TaskEditor`
in **draft mode**: a local-only object (title prefilled from the asset, attachments staged as
ids). On save: `createTask` (+ `attachTaskMaterials` for staged beyond the initial) — the
server row exists only after explicit save (FR-026, R1). Cancel/Escape discards with the
unsaved-changes prompt only when the user actually edited something. Saved tasks get a
Delete action (edit permission) → confirm → `deleteTask` (D6). The single-attachment detach
confirm modal (R3) becomes an immediate detach + Undo toast (re-attach via
`attachTaskMaterials`).

**Rationale**: Draft-then-save is the standard editor contract users expect; it also removes
the silent server write on a mis-click, which currently *cannot be cleaned up at all* — the
worst trap found (R1).

**Alternatives considered**: keep instant-create but add task delete — still creates
audit/noise per mis-click and surprises collaborators watching the realtime board; "quick
create with toast-undo" — undo would need delete anyway and still flashes phantom tasks to
teammates.

## D14. Resolver: direct entry, wizard back, drive-return

**Decision**: The `/team` resolver's order: (1) `?drive=` OAuth return → resume wizard (as
today, `TeamSpace.tsx:60-69`); (2) URL space id → enter it (D1); (3) pending invitations
present → lobby; (4) exactly one team and it is `ready` (`spaceReadiness`,
`lobby/SpaceCard.tsx:14-23`) → redirect into it (`replace`, so Back does not bounce);
(5) remembered space → redirect; (6) lobby. The wizard's folder step gains the Back action
using the already-present `teamCreateBack` key (N5); name state is kept in wizard state (it
already is — the step split just never exposed the button).

**Rationale**: Deterministic, testable order; FR-005's "and no pending invitations" guard
comes free from step 3 preceding step 4.

**Alternatives considered**: auto-entering even with pending invitations (badge only) —
violates FR-005's explicit condition and hides the one thing a new invitee must see.

## D15. Weak-hardware responsiveness tactics

**Decision**: Structural, not micro-optimizations: lazy row menus (D4), one live overlay at a
time (D9), per-card preview requests stay lazy but get a session-scoped in-memory URL cache
(keyed by material id + variant) so re-renders and re-opens stop re-fetching (P2), list pages
stay capped at 50 with explicit load-more (existing), and the tab bar renders sections
mounted-on-demand (`key`ed as today). No virtualization, no workers, no Suspense rework.
SC-009 is verified manually per `quickstart.md` on the reference machine.

**Rationale**: The measured problems (P1/P2) are mount-count and request-count problems;
these tactics remove them without new complexity for a 50-item ceiling.

**Alternatives considered**: react-window virtualization — dependency + churn for lists
capped at 50; server-side batch signed-URL endpoint — backend scope the spec avoided.

---

**All Technical Context unknowns resolved. No NEEDS CLARIFICATION remain. → Phase 1.**
