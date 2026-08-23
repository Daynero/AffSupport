# Implementation Plan: Переосмислений UX командного режиму

**Branch**: current work continues on the active git branch (`fix/stop-leaves-nothing-running` at planning time; no feature branch was created — no `before_specify`/`before_plan` hook is configured). _(Spec Kit feature: `010-team-ux-refresh`)_ | **Date**: 2026-08-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-team-ux-refresh/spec.md`

## Summary

This feature reworks the **experience** of the existing team mode — navigation, feedback,
reversibility, invitations lifecycle, dialog and language consistency, and background
processing continuity — on top of the capabilities shipped in 001/002/004/005. The evidence
base is `findings.md` (30 located findings, N/F/S/I/R/C/B/P). Almost all work is in
`apps/web/src/team/**` plus a small, sharply bounded backend addition: **three new SQL
functions** (`leave_team`, `delete_draft_team`, `delete_team_task`) and **one trash-listing
read** — everything else reuses existing RPCs and the `drive-ops` Edge Function unchanged
(`restoreMaterial`, `listMyInvitations`, `accept/declineInvitation` already exist and are
merely surfaced).

The seven headline moves, mapped to spec stories:

1. **US1** — real addressable sections: `/team/:spaceId/:section` parsed from the existing
   hand-rolled router (`lib/navigation.ts` + a prefix match in `ProtectedSoty.tsx`), a
   persistent tab bar with an explicit Files tab, a space-name switcher, and single-ready-space
   direct entry.
2. **US2** — file actions move into the Files browser rows; search availability keys off the
   space-wide `catalogFreshness.discoveredCount` (already returned by every catalog probe)
   instead of the current folder's item count; destination selection becomes a shared visual
   folder picker; catalog search gets a real pager.
3. **US3** — one `ToastProvider` (new shared context, constitution-VI idiom) carries every
   action outcome; machine codes map to `TranslationKey` copy in one helper; sync banner gains
   failed/unavailable states plus a poll fallback; the realtime state chip renders from the
   already-tracked `realtimeState`.
4. **US4** — the account-page invitation inbox is extracted into a shared component and
   rendered in the lobby; `leave_team` / `delete_draft_team` RPCs complete the membership
   lifecycle; non-manager members get an explanatory disconnected-space state.
5. **US5** — trash becomes reversible in the UI (undo toast + trash view over the existing
   `lifecycle='trashed'` catalog rows and `drive-ops/restore`); task creation goes through a
   draft editor (`create_team_task` fires only on save); `delete_team_task` closes the loop;
   confirmation friction is re-proportioned.
6. **US6** — the seven hand-rolled overlays are ported onto `components/Modal`; the
   glossary in the spec's «Термінологія» table becomes an enforced i18n contract with a
   repo test; placeholder copy is replaced.
7. **US7** — the library batch claim loop moves out of `ProcessLibraryDialog` into a
   space-level provider so closing the dialog no longer cancels the batch; a header chip shows
   background progress.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true`, ESM `NodeNext` (`.js` import specifiers); React 18 functional components; SQL (Postgres/Supabase migrations).

**Primary Dependencies**: React + Vite (`apps/web`), Supabase JS client (RPC + Edge Functions + Realtime), `@video-compressor/shared` contract package. **No new runtime dependencies** — routing stays hand-rolled (`lib/navigation.ts`), state stays React context, styling stays `styles.css` classes.

**Storage**: Existing Supabase Postgres (teams, memberships, invitations, catalog with `lifecycle` column, tasks, library jobs, audit events). No new tables; three new SQL functions + one listing read; forward-only migration(s) with `ROLLBACK.md` notes.

**Testing**: Vitest in central `tests/` (`*.test.ts(x)`), jsdom via `// @vitest-environment jsdom` docblock for DOM tests, PGlite for SQL function tests (existing team-contract harness — `scripts/generate-team-contract-sql.mjs`), `vi.hoisted` + `vi.mock`. New: an i18n glossary-enforcement test.

**Target Platform**: Browser web app (Cloudflare Pages build of `apps/web`); Supabase (migrations + no Edge Function changes expected beyond none); the local agent is untouched.

**Project Type**: Web application inside the npm-workspaces monorepo (`apps/web` + `supabase/`); `apps/agent` and `packages/shared` are expected to remain untouched (verify at release: a web-only deploy must not carry unreleased agent/shared changes).

**Performance Goals**: SC-009 — interaction response ≤200 ms on 50-item lists on the project's weak reference machine. Achieved structurally: stop mounting 50 live `MaterialActions` under `<details>` (lazy row menus), keep per-card preview fetches lazy + session-cached, keep list pages capped at 50.

**Constraints**: No router/data-fetching/toast libraries (constitution VI); i18n is the compile-checked `TranslationKey` union; error codes stay machine-stable at the API boundary (constitution V) — humanization happens only at render; team-mode URLs must not leak space existence to non-members (001 FR-016).

**Scale/Scope**: ~6 team surfaces re-composed; ~35–45 files in `apps/web/src/team/**` touched; 3 new SQL functions + 1 migration; ~120–180 new/renamed i18n keys ×2 locales; no changes to agent HTTP contracts.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.0.0 before Phase 0; re-checked after Phase 1.*

| # | Principle | Verdict | How this plan complies |
|---|---|---|---|
| I | Type-safe contracts, validated at the boundary | PASS | New RPC wrappers in `api/team.ts` follow the existing pattern: `unknown` → explicit guard → typed result; no `as` casts; route/section parsing returns a discriminated result; new i18n keys extend the `TranslationKey` union. |
| II | One source of truth for release/protocol | PASS | No version, manifest, or protocol change. `packages/shared` is not expected to change (the `CatalogSearchResponse` freshness envelope already carries what US2 needs). Release gate: ship as a web+Supabase change; re-verify no unreleased agent/shared deltas ride along (`verify-release`). |
| III | Security & least privilege by construction | PASS | New SQL functions are `security definer` with `set search_path = ''`, fully-qualified names, permission checks via the existing `private.can`/membership helpers, and audit rows for every mutation (`membership.left`, `team.draft_deleted`, `task.deleted`). `delete_draft_team` refuses teams that ever had a drive connection. Deep links resolve through existing RLS reads — a non-member gets the same neutral denial as today (no existence leak). No client-fabricated confirmation replaces a server-validated path (R3's replace-root confirm is aligned back to the connect-time server validation). No secrets touched. |
| IV | Disciplined child-process orchestration | PASS (n/a mostly) | Agent untouched. The lifted batch loop keeps the existing lease semantics: claim → heartbeat → complete/fail/cancel; unmount of the *provider* (leaving `/team` entirely or closing the tab) releases the active attempt exactly as the dialog does today, and expired leases remain reclaimable by design. |
| V | Consistent HTTP API & error conventions | PASS | Error envelopes keep stable machine codes (`{ error }`); the UX change is render-side mapping code→copy. New RPCs return state snapshots / typed rows consistent with the 001 surface; no envelope reshaping. |
| VI | Frontend composition & state discipline | PASS | New global stores use the mandated context idiom (`createContext<T \| null>` + throwing hook + test override): `ToastProvider`, `LibraryProcessingProvider`. Routing extends `lib/navigation.ts` — no router lib. All copy via `useI18n`; styling via `styles.css` classes + tokens; `any` stays out. The rework *pays down* listed debts (TeamCatalog's 7 overlay booleans → one discriminated overlay state; `MaterialActions` split; no new 1000-line files) rather than extending them. |
| — | Workflow & quality gates | PASS | `npm run format:check`, `npm run lint`, `npm test` before PR; `npm run build -w @video-compressor/web` for type safety; DOM tests with jsdom docblock in `tests/`; PGlite tests for the three new SQL functions; migrations `YYYYMMDDHHMMSS_<slug>.sql` forward-only + `ROLLBACK.md` entry; `npm run types:supabase` after migration. |

**Initial Constitution Check: PASS — no violations to justify.**
**Post-Phase-1 re-check: PASS** — the design added no new projects, no new dependencies, no envelope changes; the only backend growth is three narrowly-scoped SQL functions matching the existing security template.

## Project Structure

### Documentation (this feature)

```text
specs/010-team-ux-refresh/
├── spec.md              # Feature specification (7 stories, FR-001..032, SC-001..010)
├── findings.md          # Located evidence (N/F/S/I/R/C/B/P finding IDs → FRs)
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1..D15 resolving every design unknown
├── data-model.md        # Phase 1 — entities, states, transitions touched by the refresh
├── quickstart.md        # Phase 1 — how to run, verify per-story, and gate the work
├── contracts/           # Phase 1 — routes, RPC signatures, glossary, UI conventions
└── tasks.md             # Phase 2 ($speckit-tasks — not created here)
```

### Source Code (repository root)

```text
apps/web/src/
├── lib/navigation.ts                # reused as-is (navigateTo/useBrowserRoute/internalLink)
├── ProtectedSoty.tsx                # '/team' exact match → '/team' prefix match
├── HomePage.tsx                     # entry card: pending-invitations badge
├── components/
│   ├── Modal.tsx                    # reused as the single dialog primitive
│   └── toast.tsx                    # NEW ToastProvider/useToasts (action-capable, aria-live)
├── i18n.ts                          # key renames + new keys (glossary contract)
├── styles.css                       # tab bar, chips, trash view, toast, z-index tokens
├── api/team.ts                      # + leaveTeam, deleteDraftTeam, deleteTask, listTrashedMaterials
└── team/
    ├── TeamSpace.tsx                # route-driven resolver (space/section from URL)
    ├── TeamContext.tsx              # + realtime chip source; membership-lost message hook
    ├── routes.ts                    # NEW: parse/build /team/:spaceId/:section (+query)
    ├── SyncProgress.tsx             # + failed/unavailable states, retry action
    ├── useCatalogFreshness.ts       # + poll fallback when realtime is not connected
    ├── lobby/                       # + InvitationList (shared), draft delete, leave entry
    ├── create/                      # wizard: Back step; draft-delete on cancel option
    ├── workspace/
    │   ├── WorkspaceShell.tsx       # tab nav, space switcher, background-work chip
    │   └── SpaceSettings.tsx        # leave space action; unchanged management panels
    ├── catalog/                     # MaterialBrowser + row actions; TeamCatalog pager;
    │   │                            # overlay state machine; FolderPicker (shared); trash view
    ├── library/
    │   ├── ProcessLibraryDialog.tsx # becomes a viewer over the provider
    │   └── LibraryProcessingProvider.tsx  # NEW: lifted claim loop + progress state
    ├── tasks/                       # TaskSpace/TaskEditor: draft mode, delete, lighter detach
    ├── preview/ · landings/         # ported onto Modal; toolbar wrap fixes
    └── members/                     # InvitationPanel confirm+feedback; extracted inbox reuse

supabase/
├── migrations/2026….sql             # leave_team, delete_draft_team, delete_team_task,
│                                    # trash listing read; grants + audit actions
└── functions/                       # no changes expected (drive-ops trash/restore reused)

tests/
├── team-ux-navigation.test.tsx      # NEW (jsdom): tabs, URL restore, back, direct entry
├── team-ux-files.test.tsx           # NEW (jsdom): row actions, search availability, pager, picker
├── team-ux-feedback.test.tsx        # NEW (jsdom): toasts, code mapping, sync states, chip
├── team-ux-lifecycle.test.tsx       # NEW (jsdom): lobby invitations, leave, draft delete
├── team-ux-reversibility.test.tsx   # NEW (jsdom): trash undo/view, task draft/delete, confirms
├── team-ux-dialogs.test.tsx         # NEW (jsdom): Modal behavior across ported overlays
├── team-ux-background.test.ts(x)    # NEW: provider survives dialog close; cancel is explicit
├── team-i18n-glossary.test.ts       # NEW: glossary/placeholder enforcement over i18n bundles
└── team-membership-actions.test.ts  # extended (PGlite): 3 new SQL functions
```

**Structure Decision**: single web app + Supabase, matching the monorepo layout above; no new
packages, no new workspaces, agent untouched. New shared UI lives in `apps/web/src/components/`
(toast) and `apps/web/src/team/` (routes, folder picker, processing provider) beside their
consumers, following the existing seams.

## Complexity Tracking

No constitution violations — table intentionally empty.
