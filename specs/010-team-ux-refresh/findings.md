# Audit Findings — Team Mode UX Refresh

**Created**: 2026-08-23
**Method**: Two independent read-only audits at commit `78f1d88` (branch `fix/stop-leaves-nothing-running`): (1) a full surface map of `apps/web/src/team/**` — every screen, dialog, action, and state path; (2) an intent audit of `specs/001|002|004|005` and `docs/TEAM_WORKSPACE_*.md` against the implementation. No build, test, or browser run was performed.
**Status**: Inventory. This file is the evidence behind `spec.md`. Each finding names the requirement it motivates (`→ FR-xxx`) or the success criterion (`→ SC-xxx`). Severity: **H** high, **M** medium, **L** low.

**Confidence — read before acting.** All findings come from reading source, not from observing a browser. `file:line` references were read directly by the auditors but only C3 was independently re-verified. Before building against any finding, open the cited line; before building against a _behavioral_ claim (e.g. "background page stays clickable", "banner freezes"), reproduce it once by hand. Line numbers drift — treat them as anchors, not coordinates.

---

## N. Navigation & orientation

- **N1 (H)** Shell navigation is a row of six equal secondary _toggle_ buttons; there is no "Files" tab — returning to the default view means un-pressing the active button (`workspace/WorkspaceShell.tsx:74-126`, toggle pattern at `:84,92,100,109,118`). An intended Files tab exists as an unused i18n key `teamSpaceContentTab: 'Files'` (`i18n.ts:1220`). No `role="tablist"`/tab semantics, only `aria-pressed`. → FR-001, FR-002.
- **N2 (H)** Everything below `/team` is component state (`ProtectedSoty.tsx:63`; resolver `TeamSpace.tsx`). No deep links; browser Back exits team mode entirely; refresh resets to the content view (`WorkspaceShell.tsx:55-60`). → FR-004.
- **N3 (M)** "Change space" sits as a peer button among content views; space identity (h1) is display-only (`WorkspaceShell.tsx:76-124`). → FR-003.
- **N4 (M)** Single-space users are forced through a one-card lobby by an explicit 002 decision flagged for later revision (`specs/002-team-space-guided-flow/spec.md` Assumptions, "єдина команда" note). → FR-005.
- **N5 (L)** Wizard step 2 has no Back to the name step (`create/ConnectFolderStep.tsx:200-204`); `teamCreateBack` (`i18n.ts:1215`) is defined and unused. → FR-006.

## F. File management

- **F1 (H)** The search view — the only surface with full file actions — is gated on `hasContent`, which is set from the item count of the _currently viewed folder_ (`WorkspaceShell.tsx:104` gate; `:68-70` ← `catalog/MaterialBrowser.tsx:63`). A space whose root holds only subfolders never shows search, filters, or any file management. → FR-008.
- **F2 (H)** Rename/move/download/trash/process/new-version live _only_ in that search view, behind a per-row `<details>` "More actions" (`catalog/MaterialResults.tsx:161-175` → `catalog/MaterialActions.tsx:266-355`). The default file browser offers only Preview / Copy link / Create task (`MaterialBrowser.tsx:152-181`). Rename = 5+ steps through a conditionally invisible view. → FR-007.
- **F3 (H)** Catalog search has `page`/`setPage` state and `pageSize: 50` but renders no pagination control — results beyond 50 are unreachable (`catalog/useCatalogSearch.ts:87,170-171`; no control in `TeamCatalog.tsx`). → FR-010.
- **F4 (M)** Three flows ask for a raw Drive folder ID in a text field while a visual folder browser already exists (`drive/DriveFolderBrowser.tsx`): move destination (`MaterialActions.tsx:403-406`), process output (`processing/ProcessMaterialDialog.tsx:123-126` — opens pre-showing the error "Choose a destination folder." with Start disabled and no picker, because `TeamCatalog.tsx:223` passes `destinationFolderId={null}`), save-text-as-new-version (`TeamCatalog.tsx:371-374`). → FR-009.
- **F5 (M)** `MaterialBrowser` never receives the realtime `revision` prop, so the file tree ignores live catalog events; only manual folder navigation refetches (`WorkspaceShell.tsx:184`). → FR-011.
- **F6 (L)** Dead/unreachable UI: task drag-selection is fully wired but never enabled (`MaterialBrowser.tsx:37-40,113-148`; `tasks/TaskAttachmentPicker.tsx:227-235` still advertises the drop target); "Upload new version" requires a `destinationFolderId` no caller passes (`MaterialActions.tsx:284`); "Replace exact file" on conflict requires a `replaceMaterialId` never passed (`MaterialActions.tsx:420`); restore path unreachable (see R2). Wire or remove during the US2 rework. → FR-007.

## S. Feedback & status

- **S1 (H)** Team mode never uses the app's toast system (`App.tsx:132-137`). Raw machine codes render in place of human copy: `MaterialActions.tsx:448-450` (rendered at `:435-439`), `ProcessMaterialDialog.tsx:140-144`, `library/LibraryShareActions.tsx:151`, `catalog/TeamTextEditor.tsx:105-109`, `processing/OperationStatus.tsx:34`, `members/TeamAuditPanel.tsx:73`, interpolated into copy at `library/BulkUploadDialog.tsx:380,393` and `library/ProcessLibraryDialog.tsx:422`. → FR-013, FR-014.
- **S2 (H)** Silent no-op controls: "Provenance" has no `.catch` — a rejected fetch does nothing forever (`TeamCatalog.tsx:168-172`), and an empty result renders an overlay containing only a Cancel button (`preview/ProvenancePanel.tsx:22` returns null); "Edit text" silently returns unless the transcript is `full` (`TeamCatalog.tsx:105-116`). → FR-015.
- **S3 (M)** Bare "…" loaders with no label: `lobby/SpaceLobby.tsx:31`, `MaterialBrowser.tsx:91`, `MaterialResults.tsx:51`, `TeamCatalog.tsx:312` (a just-started process renders as a lone inline "…"). The access check renders a blank dimmed screen with no spinner or text (`TeamSpace.tsx:151-158`). → FR-016.
- **S4 (H)** Sync status contradicts itself: `syncLabel` hardcodes "Catalog is up to date" whenever the connection state is `connected` (`WorkspaceShell.tsx:194`) while the banner above may say "Syncing…"; `SyncProgress` renders _nothing_ for `failed`/`unavailable` (`SyncProgress.tsx:13-18,49`) — a failed sync's only trace is a small string inside the conditionally hidden search view (`MaterialResults.tsx:62`). → FR-017.
- **S5 (M)** Freshness refetches only on realtime `revision` changes — no polling, no error surface (`useCatalogFreshness.ts:33-57`); the realtime state (`connecting|connected|reconnecting|disabled`) is never rendered anywhere (`TeamContext.tsx:24`; `useTeamRealtime.ts:90-94`). A dropped channel freezes the banner on "Syncing…" indefinitely. → FR-018.
- **S6 (M)** Losing membership silently drops the team and bounces the user to the lobby mid-task (`TeamContext.tsx:123-126`). → FR-019.
- **S7 (M)** A failed local process start silently cancels the operation (`.catch(() => cancelOperation(...))`, `TeamCatalog.tsx:137-139`) — the status overlay then reads "canceled", not an error. → FR-013.
- **S8 (M)** Fire-and-forget mutations with no `.catch` and no success feedback: remove member (`members/MemberList.tsx:206-214` — a failure leaves the confirm modal open with a dead button), resend/revoke invitation (`members/InvitationPanel.tsx:132-146`), detach Drive (`drive/DriveConnectionPanel.tsx:216-221`); copy-link failure surfaces only as a `title` tooltip (`catalog/CopyDriveLinkButton.tsx:53-67`); clipboard errors are misreported as a Drive failure (`LibraryShareActions.tsx:56-60`); partial bulk-move failure names no items (`library/CreativeLibrary.tsx:258-260`). → FR-013, FR-014.
- **S9 (L)** Empty states lie: `teamTasksEmpty` = "No tasks for this date." shows even with the filter on "all" and offers no create CTA (`tasks/TaskSpace.tsx:154`; `i18n.ts:1346`), unlike the library which has one (`CreativeLibrary.tsx:273-286`); first-load search shows "No materials match these filters." (`MaterialResults.tsx:52`); audit shows "No events" while still fetching (`TeamAuditPanel.tsx:47`). → FR-020.

## I. Invitations & membership lifecycle

- **I1 (H)** Incoming invitations render only inside the account page (`pages/AccountPage.tsx:240` InvitationInbox); the team lobby and the home entry card show nothing. The API is complete: `listMyInvitations`/`acceptInvitation`/`declineInvitation` (`api/team.ts:1155,1225,1236`). → FR-021.
- **I2 (H)** A non-owner cannot leave a space: the only removal RPC requires `manage_members` on the actor (`supabase/migrations/20260801100000_team_membership_actions.sql:169`). → FR-022.
- **I3 (M)** No delete-team exists; an abandoned create wizard permanently leaves a `setup_incomplete` space in every member's lobby — documented as accepted first-release debt (`specs/002.../spec.md` Assumptions; `create/CreateSpaceWizard.tsx:20-25`). → FR-023.
- **I4 (M)** A non-manager member of a detached space sees an empty file tree ("No visible materials in this folder yet.", `i18n.ts:944`) with no explanation — the Drive panel is owner-gated (`workspace/SpaceSettings.tsx:121`); only the landings view explains the real cause (`landings/TeamLandings.tsx:119-120`). → FR-024.

## R. Reversibility & confirmations

- **R1 (H)** "Create task" on any card immediately persists a server record titled `Task: <name>` with no confirm (`tasks/TaskSpace.tsx:73-111`, write at `:86-90`), and no `deleteTask` exists anywhere in `api/team.ts` — mis-clicks accumulate forever. → FR-026, FR-027.
- **R2 (H)** Trash is one-way in the UI: `restoreMaterial` exists and `MaterialActions` has a restore branch, but no caller ever passes `trashed: true` and no trash view exists (`MaterialActions.tsx:337-354` unreachable). Trashing itself is a single un-confirmed click (`MaterialActions.tsx:319-336`). → FR-025.
- **R3 (M)** Confirmation friction is inverted. Un-confirmed, single-click: Detach Drive (also no error handling — `DriveConnectionPanel.tsx:296-300`, `:216-221`), Revoke invitation (`InvitationPanel.tsx:219-223`), Replace root (client fabricates the confirm locally instead of the server-validated path used at initial connect — `DriveConnectionPanel.tsx:154-161,279-290`). Meanwhile detaching one attachment from a task demands a full nested confirm modal (`tasks/TaskAttachmentTile.tsx:353-384`). → FR-028.

## C. Consistency — dialogs, language, copy

- **C1 (H)** Two incompatible dialog systems. 14 surfaces use `components/Modal` (portal, focus trap, Escape, scroll lock, z-index 100). 7 are hand-rolled `position:fixed` overlays with **no portal, no focus trap, no Escape, no scroll lock, and no backdrop**: `ProcessMaterialDialog.tsx:89`, `TeamTextEditor.tsx:66`, `TeamCatalog.tsx:244,314,369`, `preview/MaterialPreview.tsx:199`, `landings/LandingFullView.tsx:79` (overlay style `styles.css:10591-10607`, z-index 45). The page behind stays scrollable and clickable, so overlays stack into dead layers; preview z-index 80 < modal 100, so a preview opened while a Modal is up renders _underneath_ it (`styles.css:10285-10293` vs `:5680`). `MaterialPreview`/`LandingFullView` claim `aria-modal="true"` without implementing modality. `TeamCatalog` juggles 7 mutually-exclusive overlay booleans with no single overlay state (`TeamCatalog.tsx`). → FR-029.
- **C2 (M)** Vocabulary drift across one screen and both locales: space/team/workspace in a single header (`WorkspaceShell.tsx:76-124`; `i18n.ts:1194-1195`); file/material/asset/media/creative for the same object (`i18n.ts:943` "Materials", `:1222` "TEAM MEDIA", `LibraryAssetSummary`, `teamCatalogFile`); "Creative Library" as nav label vs "Library" as panel title vs "Library" as a _stage inside it_ (`i18n.ts:1221,1223`; `CreativeLibrary.tsx:178-203`); tasks-vs-jobs; three distinct Cancel keys with `teamFileCancel` used as a _Close_ label (`i18n.ts:883,1128,1216`; used at `ProcessMaterialDialog.tsx:97`, `TeamTextEditor.tsx:73`, `TeamCatalog.tsx:246`); uk locale uses transliterated slang "Таски" against an otherwise formal register (`i18n.ts:2753,2770,2792`); `teamTaskLoading` ("Loading task…", singular) reused for the task list and the picker's folder listing (`TaskSpace.tsx:151`, `TaskAttachmentPicker.tsx:294`). → FR-030, FR-031.
- **C3 (H, verified)** The waitlist gate title — the first thing every non-allowlisted user sees at `/team` — is the placeholder `'ДОНТ ПУШ ЗЕ ХОРСИС'` in **both** the en and uk bundles (`i18n.ts:872`, `:2291`). Verified by grep during this audit. → FR-030.

## B. Background work

- **B1 (H)** Closing the batch-processing dialog cancels the in-flight batch: unmount → `releaseActive()` → cancel (`library/ProcessLibraryDialog.tsx:459-465`). The 135-line job-claim loop lives inside the dialog component itself (`:213-348`), so the work cannot outlive the window, and no persistent progress affordance exists in the shell. → FR-032.

## P. Performance & layout (weak-hardware relevance)

- **P1 (M)** A full search page mounts up to 50 _live_ `MaterialActions` instances (476 lines, 8 state hooks, file inputs each) inside always-in-DOM `<details>` elements (`MaterialResults.tsx:64-179`). → SC-009.
- **P2 (M)** One signed-URL preview request per card/attachment as they scroll into view — 50 per library page, up to 50 inside a single task's attachment grid (`library/LibraryAssetVisualPreview.tsx:81-94`; `TaskAttachmentTile.tsx:102-151`). → SC-009.
- **P3 (L)** Layout rough spots: the six-button shell header wraps into ragged rows between ~560–860 px (`styles.css:9844-9850`); task grid rows are fixed at 278 px and clip long content (`styles.css:11228-11234`); the landing full-view toolbar has no wrap rule on narrow widths (`styles.css:10310-10314`); the backdrop-less overlays let the page scroll behind them on touch (`styles.css:10591-10607`). Falls out of the US1/US6 rework. → FR-001, FR-029.

---

## Do not break (observed strengths)

- `components/Modal` is a solid primitive (portal, focus trap, Escape, scroll lock) — C1 is fixed by converging on it, not by a third system.
- `SyncProgress`'s happy path is genuinely good (discovered counts, self-ticking "updated N ago", 90 s stall hint) — S4/S5 extend it to the unhappy states.
- Permission-shaped UI (disallowed actions hidden, not disabled) is in place and must survive the rework (002 FR-020).
- 18 distinct empty-state i18n keys already exist; S9 is about truthfulness, not absence.
- The name-conflict flow (keep-both / replace / cancel) and provenance records satisfy 001 and stay as-is.

## Spec-intent context worth keeping in view

- 002's own success criteria promised: one obvious entry (SC-001), one-action repeat entry (SC-003), nothing removed only relocated with every 001 capability ≤2 actions away (FR-019/SC-005), no filters on empty spaces (FR-017). F1/F2 show the implementation drifted from that promise — the refresh realigns with 002's spirit, then supersedes it in the three points listed in `spec.md` Assumptions.
- All four team specs' moderated UX validations (001 T051/T079/T091/T113/T123) were never run — headline usability claims are unverified. The SC list in `spec.md` re-states the measurable bar for this pass.
- Team mode sits behind an admin allowlist (`supabase/migrations/20260809150000_team_workspace_access_gate.sql`; `docs/BETA.md`), invitations in beta are copy-the-link (`docs/BETA.md`), and Drive OAuth is gated externally (`docs/TEAM_WORKSPACE_OPERATIONS.md`) — all out of scope here and unchanged.

---

## T001 — audit confirmation pass (2026-08-23)

Re-verified against the working tree at implementation start. The beta stack was not
launched for this pass (weak reference machine); each claim was confirmed at source level
by re-reading the cited code. The runtime walkthrough stays scheduled as T065 (quickstart
manual pass), which is where a runtime _correction_ would be recorded if one appears.

| ID  | Claim                                                                                                   | Verdict       | Evidence re-read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Two dialog systems; hand-rolled overlays lack portal/backdrop/focus trap; preview renders under a modal | **Confirmed** | `styles.css:10647-10651` — `.team-operation-overlay, .team-text-editor, .team-process-dialog` are `position: fixed; z-index: 45` with no backdrop rule; `ProcessMaterialDialog.tsx:89` and `TeamTextEditor.tsx:65` return a bare `<section>` (no `Modal`); `MaterialPreview.tsx:203` and `LandingFullView.tsx:83` set `aria-modal="true"` without modality, at `z-index: 80` (`styles.css:10343`) below `Modal`'s `100` (`styles.css:5738`); `TeamCatalog.tsx:67-84` holds seven independent overlay states (`editing`, `previewing`, `textEditor`, `processing`, `activeOperation`, `provenance`, `versionDraft`). |
| S4  | Contradictory sync label                                                                                | **Confirmed** | `WorkspaceShell.tsx:194` passes `syncLabel={activeTeam?.connectionState === 'connected' ? t('teamSyncFresh') : null}` — keyed on the _Drive connection_ state, never on freshness; `MaterialBrowser.tsx:80` renders it verbatim beneath the banner. `SyncProgress.tsx:13-18` maps only `scanning`/`replaying`/`not_started` to a heading and returns `null` for everything else, so `failed`/`unavailable` render nothing.                                                                                                                                                                                          |
| S5  | Freshness freezes on dropped realtime                                                                   | **Confirmed** | `useCatalogFreshness.ts:34-57` — a single effect keyed on `[client, enabled, revision, teamId]`, no timer, no polling; a dropped channel stops `revision` from advancing so the last `scanning` snapshot persists. The `.catch` silently sets `null` (banner vanishes, no error surface). `realtimeState` is read only by `useCatalogSearch.ts:41,135` for refetch-on-reconnect and is rendered nowhere.                                                                                                                                                                                                            |
| B1  | Closing the batch dialog cancels the run                                                                | **Confirmed** | `ProcessLibraryDialog.tsx:206-211` — an unmount effect calls `releaseActive()` whenever an attempt is live; `releaseActive` (`:185-204`) cancels the agent attempt, the library job lease and the operation. The claim loop (`run`, `:213-348`) is a `useCallback` inside the dialog component, so it cannot outlive the window.                                                                                                                                                                                                                                                                                    |

No corrections required — the four claims stand as written, and T002+ proceed against them
unchanged.

---

## T064 / T066 — release gate pass (2026-08-24)

Gates were run one at a time on the weak reference machine (vitest capped at two workers)
rather than as one parallel sweep.

| Gate                                     | Result                                     |
| ---------------------------------------- | ------------------------------------------ |
| `npm run format:check`                   | Pass                                       |
| `npm run lint`                           | Pass                                       |
| `npm test` (full vitest, 2 workers)      | Pass — 3579 tests, after the fallout below |
| `npm run build -w @video-compressor/web` | Pass                                       |
| `npm run test:db`                        | Pass — 374 tests, after the fallout below  |

Two failures surfaced. Neither came from feature 010, and both were repaired here because
they make the gate unrunnable for anyone else who runs it the same way.

**A test that identified its subject by novelty rather than by parentage.**
`tests/stop-releases-machine.test.ts > finds an abandoned grandchild that the exit signal
reports nothing about` failed in the parallel run and passed in isolation. It located the
orphan by scanning the whole process table for any `node` that was not running a moment
ago — a description that also fits every stub another test file spawns concurrently, so it
adopted a stranger and then failed when the stranger exited. It now matches on `ppid ===
encoder.pid`: `detached: true` opens a new session but does not reparent, so while the
encoder is alive its grandchild is exactly that row. The abandonment under test still
happens afterwards, when the encoder dies and the survivor is moved to init. Verified
green under the same concurrency that produced the failure.

**A fixture-id collision that hid the database gate from anyone using the beta stack.**
`supabase/tests/database/rls.test.sql` inserted `auth.users` rows at
`11111111-…`/`22222222-…`/`33333333-…`, and `supabase/fixtures/beta-seed.sql` already
claims those ids. On any database where `npm run beta:reset` has run, the file died on
`users_pkey` before its first assertion — 19 of 22 subtests unrun. The test's ids moved to
an `f1000000-` space of its own; the two files' spaces are now disjoint, and a note in each
says so. No database reset was needed and no local data was touched.

**T066 precondition is NOT satisfied — this is the one open blocker.** `verify-release.mjs`
(`:317-332`) fails a web deploy whose HEAD carries `apps/agent` / `packages/shared/src`
changes absent from the release tag. Against `v1.0.3` there are 24 such committed files
(agent queue, power, landing, media-actions, transcription; shared `lifecycle.ts`,
`types.ts`, `team/transport.ts`), plus uncommitted work in the same paths. **A new Agent
release must be cut and tagged before the 010 web+Supabase deploy**, or `npm run deploy:web`
will fail its own precondition.

The migration's reverse steps _are_ in place: `supabase/migrations/ROLLBACK.md:23-33` covers
`20260823120000_team_ux_lifecycle.sql` (drop `list_team_trashed_materials`,
`delete_team_task`, `delete_draft_team`, `leave_team`; restore the
`private.record_team_audit` whitelist afterwards, once no `task.deleted` row remains).

## T065 — manual quickstart pass: attempted, blocked (2026-08-24)

The beta stack came up cleanly and both halves answered — agent on `:43140` and web on
`:5175` returned `200`, `npm run beta:doctor` reported the environment ready. The walkthrough
itself could not be driven from this session: the shell that started the stack runs in a
sandbox with its own loopback, so the ports exist for `curl` inside it and do not exist for
the browser on the host. Chrome returned `ERR_CONNECTION_REFUSED` for `:5175`, for `:43140`
and for Supabase Studio on `:54323` alike, which rules out a per-site permission and points
at the network boundary. `localhost` additionally resolves to `::1` while Vite binds IPv4
only — worth knowing when running this by hand, but not the cause here.

**T065 therefore stays open, and it is the last piece of unverified work in this feature.**
It needs a human on the host: US1–US7 in `quickstart.md`, of which US1.3 (non-member link),
US2 (a second account adding a file), US4 (invite, accept, leave) and US7 (a paired local
agent) need a second signed-in account, and the Drive-dependent flows need the opt-in OAuth
test client from `docs/BETA.md`. The SC-009 spot-check belongs to the same pass, on the weak
reference machine, in a 50-item search page.

What is already known without it: the DOM half of every story is covered by the `team-ux-*`
suites, and the SQL half by `supabase/tests/database/team-workspace.test.sql` — all green in
the gate above. What the manual pass adds is the part no suite can assert: whether the thing
feels like one product to a person using it.

The stack was stopped again (`npm run beta:down`, then `colima stop`) rather than left
running, so nothing is holding the machine.

## Agent API pass on the running beta stack (2026-08-24)

Not part of T065 — the manual pass still needs a browser. This is what could be checked
without one, against the beta agent on `127.0.0.1:43140`, built from `b3c372d` (the commit
above) and reporting `environment: beta`, `apiVersion: 5`, `entitlement.entitled: true`,
`ffmpeg`/`ffprobe` both ready.

**Authentication holds.** Every `/api/*` route answers `401` unpaired. The pairing redirect
at `/local` issues a 64-hex token in the fragment, and the same routes answer `200` with it.
`/health` stays public, as the unauthenticated liveness probe it is meant to be.

**Method surface is honest.** `GET` on `/api/entitlement`, `/api/landing/settings`,
`/api/transcription/settings`, `/api/landing-preview/settings` and `/api/jobs/completed`
returns `404`, not `405`-shaped confusion or an empty `200` — those are `POST`/`DELETE`
routes, confirmed at source. Read routes that should answer do: `/api/health`,
`/api/diagnostics`, `/api/landing/state`, `/api/landing-preview/state`,
`/api/transcription/state`, `/api/media-actions`.

**The multiplexed stream behaves as its own comment claims.** `/api/stream` carries six
channels over one connection — `compressor`, `landing`, `landing-preview`, `power`, `team`,
`transcription` — replacing the per-tool sockets whose disagreement about reachability the
module was written to end. The legacy `/api/events` still answers `200` and still opens with
a full `state` frame, so a client that does not see the `event-stream` capability is not
stranded. SSE headers are correct, `X-Accel-Buffering: no` included.

Its guards were exercised rather than assumed:

| Request                                         | Result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| no `channels`                                   | all six — the documented default                |
| `channels=power`                                | power only                                      |
| `channels=power,team`                           | both                                            |
| `channels=power&channels=team` (repeated param) | both — the array case the code calls out        |
| `channels=%20,%20power%20,%20` (padding)        | power only                                      |
| `channels=bogus`                                | **400**, not a silent fallback to every channel |
| 17 names with a real one past the cap           | dropped — `MAX_CHANNELS` is 16 and holds        |
| no token                                        | 401                                             |

The `bogus` case is the one worth naming: a filter that finds nothing could plausibly have
been read as "nothing asked for, so send everything", which is how a guard becomes a
firehose. It refuses instead.

Nothing here touched a destructive route — no cancel, remove, reset or delete was called.

## T065 — manual quickstart pass, run (2026-08-26)

The 2026-08-24 blocker is gone. It was never a permission or a port: the shell
that started the stack ran sandboxed, with a loopback of its own, so `:5175`
existed for `curl` inside it and for nothing else. Started outside that sandbox,
the same `npm run beta:up` binds the host's loopback and Chrome reaches the app,
the agent and Studio alike. Anyone repeating this pass should start the stack
from a shell that shares the browser's network namespace; nothing else changed.

Run one story at a time on the weak reference machine, with the stack up and no
test suite running beside it, then the suites after `beta:down` — never both.

### The database was a migration behind, and said so only as "something went wrong"

The first destructive action attempted — deleting an abandoned wizard draft —
answered with the generic `Щось пішло не так. Спробуйте ще раз за мить.` The
cause was not in the product: `public.delete_draft_team` **did not exist**.
Neither did `delete_team_task`, `leave_team` or `list_team_trashed_materials`.
The beta database's last applied migration was `20260820210000`; this feature's
`20260823120000_team_ux_lifecycle.sql` had never been applied.

`beta:up` restores the database from a snapshot — its own log says
`Starting database from backup...` — and does not replay pending migrations.
Only `npm run beta:reset` does, and `docs/BETA.md` presents reset as a *data*
reset ("seeds the fixtures, clears resettable state"), so nothing tells someone
about to validate a schema change that `beta:up` alone leaves them a schema
behind. Every US4/US5 lifecycle flow fails identically and anonymously until it
is noticed. **`docs/BETA.md` should say, under Start, that new migrations reach
the stack only through `beta:reset`** — the cheapest fix, and the one that stops
the next person losing an hour to a toast that names nothing.

Applied here as the single missing file plus its `schema_migrations` row rather
than a full reset, which on this machine is the difference between a minute and
a rebuild. After that the draft deleted cleanly: `Чернетку простору видалено`.

### One deleted task took the whole space history down — fixed

The worst thing found, and the only one that would have shipped: **Settings
showed `Не вдалося завантажити історію простору.` permanently, from the first
task anyone deleted onward.**

The migration widened `private.record_team_audit`'s target-key whitelist to
accept `task_id` and `task_title` (`20260823120000:44-54`). The client keeps its
own copy of that list, `AUDIT_TARGET_KEYS` in `apps/web/src/api/team.ts`, and it
was not widened. `mapAuditEvent` returns `null` for a row carrying a key it does
not know, and `listAuditEvents` throws `INVALID_RESPONSE` when *any* row maps to
null — so one `task.deleted` event does not lose its own line, it loses every
line, forever, for every member of that space.

Both halves were tested. `tests/team-lifecycle-rpc.test.ts:260` proves the
server writes `task_title`; `tests/team-members.test.tsx:155` mocks the client
whole and never reaches the mapper. Neither test could see the disagreement
between them, which is exactly the seam a manual pass is for.

Fixed by mirroring the server list, with a comment on each side saying the two
must be read as one. `tests/team-audit-wire.test.ts` now drives the real mapper
over the row the function actually returns, and asserts both halves of the
contract: a declared key survives, an undeclared one still fails the page
(all-or-nothing is deliberate — a partial history is a history you cannot
trust). Verified in the running app: the history renders the `task.deleted`
entry, with the id and title still absent from what is displayed.

### The lobby cannot be reached, and its own link is what proves it

`/team` never resolves to the lobby for anyone who has entered a space:

- `TeamSpace.tsx:104` redirects whenever exactly one space is *ready*.
- Failing that, `TeamSpace.tsx:111-116` redirects to the remembered space.
- `SpaceSwitcher.tsx:35` renders the switcher only when another space exists,
  and the "Усі простори" link lives **inside** that menu — so with one space
  there is no lobby link at all.

With two ready spaces the link appears and still does not work. Clicking it
calls `leaveSpace()`, which clears the active space and navigates to `/team`;
the resolver redirects straight back in, and entering rewrites
`wishly.active-team.v1` with the id that was just cleared. Leaving is undone by
the redirect that leaving triggers. Measured: after the click the key still held
`22222222-…`; the lobby rendered only after removing it by hand.
`TeamSpace.tsx:159` compounds it — `rememberedTeamId` is captured with
`useState` at mount and never re-read, so an in-app navigation cannot clear it
even in principle.

What the user loses: the create wizard and the space list, both of which live
only in the lobby. The shipped beta fixture — one ready space, one member — is
the worst case of it. Only a pending invitation forces the lobby open.

Left unfixed on purpose: every candidate fix changes what `/team` *means*, and
the resolver's rules are spec text (FR-015) and encoded in
`tests/team-ux-navigation.test.tsx`. The smallest honest shape is an explicit
"take me to the lobby" intent that the resolver honours for one navigation —
distinguishable from "I arrived at `/team` with a space remembered", which is
the case the redirect exists for. That is a decision, not a repair.

### A live channel that never connects is never mentioned

With `supabase_realtime_wishly` stopped, the space showed no chip for forty
seconds and nothing else changed either. `useTeamRealtime.ts:19` starts in
`connecting` and leaves it only on a subscribe-callback status
(`SUBSCRIBED` / `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`, `:86-93`). Kong stays
up while its upstream is dead, so the WebSocket handshake *hangs* rather than
failing — probed from the page, a raw `ws://…/realtime/v1/websocket` neither
opened, closed nor errored within six seconds. No status fires, so `connecting`
is terminal, and `RealtimeChip` draws nothing for it.

FR-018 wants the break visible. "Was connected, then dropped" is announced after
an 8-second grace; "never connected" — the worse case, because nothing the user
sees will ever update — is silent. The fix is the grace timer `reconnecting`
already has, applied to `connecting` too, so a merely slow first connect still
stays quiet. Left for the same reason as above: it is a state-machine change
with a test to match, not a one-liner.

### Two small things repaired in place

**The wizard offered a Drive button it had just called unusable.** Step 2 renders
`<BetaStorageNotice />` and, directly under `Недоступно в беті`, an enabled
`button-primary` reading `Підключити Google Drive` — measured `disabled:false`,
`aria-disabled:null`, `opacity:1`. `DriveConnectionPanel.tsx:275` guards the same
control with `externalStorageUnavailableInBeta()`; `ConnectFolderStep.tsx:154`
rendered only the notice. FR-015 asks for hidden or disabled *with* an
explanation; only the explanation had shipped. The step now uses the same
predicate as its sibling — verified: notice present, button gone.

**The space name broke in two the moment it became a switcher.** With one space
the title is a plain `<h1>` on one line; with two it wrapped, and the caret hung
detached beside the second line. Measured: header 1168 px, utilities 467 px,
`.team-space-shell-identity` 216 px at `flex: 0 1 auto` — it never grew into the
450 px of free space beside it, so the h1 sat at the bare name's max-content
width and the trigger's own chrome (padding 24 + gap 12 + caret 7) was subtracted
from that width instead of added to it, leaving 185 px for a 200 px name. Now
`flex: 1 1 auto`; the name and its caret sit on one line.

### Verified working

- **US1** — sections walk and the address follows; Back twice returns Settings →
  Tasks → Files; a section URL restores its section. A link to a space you are
  not in gives a neutral screen that does not name it and offers a way out
  (FR-016's "absent and denied answer alike" holds in the browser). One ready
  space enters directly. The wizard's step 2 has Back and the name survives the
  round trip.
- **US4** — abandoning the wizard leaves a draft card offering resume or delete;
  the delete confirmation names the space and states that nothing was saved. An
  owner is told *why* they cannot leave ("Простір не може лишитися без
  власника…") rather than being shown a dead control — FR-015 at its best.
- **US5** — "Create task" from a file row stages the attachment without
  committing it ("Файлів буде прикріплено після збереження: 1"); cancelling left
  zero tasks and zero attachment rows in the database. Creating opens the editor
  at `?task=<id>`. Deleting confirms, names the consequence *and* says the
  attached files survive it, toasts, and clears the parameter. The audit row
  lands as `task.deleted / succeeded` carrying `task_id` + `task_title`.
- **US6** — dialogs are `aria-modal`, lock the page behind them (`body` overflow
  `hidden`, restored on close), close on Escape, scroll inside themselves, and
  stack correctly (the delete confirmation renders over the task editor).
  `tests/team-i18n-glossary.test.ts` passes as the copy audit.
- **US3** — a failure names its subsystem: trashing a file with no real Drive
  gave `Google Drive не відповідає. Спробуйте трохи згодом.`, no error code.
- **US2 (partial)** — the catalog panel carries search plus seven filters, an
  honest count and `Каталог актуальний`, and the toggle relabels to `Закрити
  пошук`. Trash renders, explains Drive's ~30-day window and distinguishes empty
  from unloaded.
- Not a defect, checked because it looked like one: the create-task submit is
  enabled with an empty title, but the input is `required` on a form that is not
  `noValidate` — the browser blocks it with `Заповніть це поле.`

One observation rather than a finding: `/` focuses the catalog search, but the
listener is mounted inside `CatalogSearchBar`, so it does nothing until the
search panel is already open. A jump-to-search shortcut that only works once you
are looking at the field is doing very little; worth deciding whether it should
open the panel.

### What this pass still could not cover

Unchanged from 2026-08-24 and not repairable from here:

- **A second signed-in account** — US1.3 seen from the other side, US2's
  live-update-on-another-member's-write, US4's invite → accept → leave, and the
  membership-loss explanation. The invite form is present and the local stack
  returns the link rather than sending it, so this is one account away.
- **Google Drive** — everything downstream of storage: rename, move, trash and
  restore, the 50-item search page, and therefore **US7 entirely** and the
  **SC-009 spot-check**, which needs a 50-item page to be meaningful. This needs
  the opt-in OAuth test client from `docs/BETA.md`.

Gates re-run after the three fixes, one at a time: `prettier --check` and
`eslint` on the changed files, `typecheck:tests`, `tsc -b apps/web`,
`verify-styles`, `verify-i18n`, and the seven `team-ux-*` suites plus
`team-i18n-glossary`, `team-members`, `beta-web-environment` and the new
`team-audit-wire` — 97 tests, all green. The full suite was **not** re-run here;
it is the pre-PR gate and it last passed at T064.

The stack was stopped again (`npm run beta:down`) and the two QA spaces seeded
for this pass were removed, so the beta fixture is back to its documented
baseline of one space. The applied migration is left in place — it belongs there.

## T066 — release precondition re-checked (2026-08-26)

Still not satisfied, and further from it. Against `v1.0.3` the web deploy now
carries **40** unreleased `apps/agent` / `packaging` / `packages/shared/src`
files, up from 24 on 2026-08-24. `verify-release.mjs:336-345` fails a web deploy
on exactly this, so `npm run deploy:web` will refuse until an Agent release is
cut and tagged. That is a release decision, not a repair, and nothing here makes
it.

The other half of T066 holds: the migration's reverse steps are in
`supabase/migrations/ROLLBACK.md:23-33`, and re-reading them against the applied
schema they are correct — the four functions to drop are exactly the four the
migration creates, and the note about restoring `private.record_team_audit`'s
narrower whitelist only once no `task.deleted` row remains is right, because
this pass wrote one.

## T068 / T069 — the two open behaviours, landed (2026-08-26)

Both were left as decisions rather than repairs when T065 found them, because
each changes what a rule *means* rather than fixing a slip. Taken in turn.

### `/team` can now be asked for the lobby, and the ask is in the address

The loop was that "Усі простори" navigated to `/team`, which is the same address
someone types or bookmarks — so the resolver read an explicit request to see
every space as an ordinary arrival, and answered it by entering a space. Then
entering rewrote the remembered id that leaving had just cleared, which is why
it never converged.

The intent is now a parameter, `/team?all=1`, for the reason the rest of team
mode keeps state in the URL: it survives a refresh, so reloading the lobby keeps
you in the lobby instead of dropping you back into a space. `resolveTeamEntry`
honours it *before* the one-ready-space and remembered-space rules, and both of
those rules are otherwise untouched — arriving at `/team` behaves exactly as it
did. `leaveSpace()` navigates to the same address, since leaving is a
destination and not merely an exit.

The second half of the trap was the switcher hiding itself when there was no
other space, which took the lobby link with it. The comment justifying that
cited FR-015 — a control that cannot act should be hidden — but the premise was
false: the menu always carries the way back to the lobby, and the lobby is the
only place the create wizard exists. An owner of one space, which is what the
beta fixture and every new account is, therefore had no route to a second one.
The switcher now always opens; the "Other spaces" heading and its list appear
only when there is something in them, so nothing pretends there is.

Worth recording why no test caught this. `tests/team-space-lobby.test.tsx:45`
already clicked "All spaces" and asserted the lobby, and it passed throughout —
jsdom starts with an empty `localStorage`, so the remembered-space rule never
fired and the assertion never met the case that breaks in a browser. The new
`reaches the lobby even when a space is remembered` seeds the key first, which
is the whole difference between the two.

### A channel that never connects now says so, on the same terms as one that drops

`RealtimeChip` announced `reconnecting` after an 8-second grace and drew nothing
for `connecting`, which made the worse of the two failures the quieter one: a
channel that never came up at all was silent, while one that came up and dropped
was announced. Both states now share the grace timer, so a slow first connect
stays as quiet as a brief drop and neither flickers.

The copy is deliberately not shared. Telling someone we are *re*connecting
something they never had is a small lie the chip does not need to tell, so
`connecting` past its grace reads "No live updates yet" / «Живих оновлень ще
немає». Moving between the two waiting states restarts the timer but does not
clear an elapsed grace — once we have said live updates are missing, saying it
differently is not a reason to go quiet.

The grace path had no test at all before this: the suite covered `connected` and
`disabled` only, so neither the timer nor either warning had ever run.

### The beta note

`docs/BETA.md` now says under Start that `beta:up` restores from a snapshot and
does not replay migrations, and that only `beta:reset` does — with the reason it
is easy to miss, which is that the product cannot say "your schema is old" and
shows the generic error toast instead.

Gates after all of it, one at a time: prettier and eslint over the changed
files, `typecheck:tests`, `tsc -b apps/web`, `verify-i18n`, `verify-styles`, and
14 suites covering everything touched — 129 tests, all green. The full suite
remains the pre-PR gate and was not run here.
