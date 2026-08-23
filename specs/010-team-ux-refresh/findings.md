# Audit Findings — Team Mode UX Refresh

**Created**: 2026-08-23
**Method**: Two independent read-only audits at commit `78f1d88` (branch `fix/stop-leaves-nothing-running`): (1) a full surface map of `apps/web/src/team/**` — every screen, dialog, action, and state path; (2) an intent audit of `specs/001|002|004|005` and `docs/TEAM_WORKSPACE_*.md` against the implementation. No build, test, or browser run was performed.
**Status**: Inventory. This file is the evidence behind `spec.md`. Each finding names the requirement it motivates (`→ FR-xxx`) or the success criterion (`→ SC-xxx`). Severity: **H** high, **M** medium, **L** low.

**Confidence — read before acting.** All findings come from reading source, not from observing a browser. `file:line` references were read directly by the auditors but only C3 was independently re-verified. Before building against any finding, open the cited line; before building against a *behavioral* claim (e.g. "background page stays clickable", "banner freezes"), reproduce it once by hand. Line numbers drift — treat them as anchors, not coordinates.

---

## N. Navigation & orientation

- **N1 (H)** Shell navigation is a row of six equal secondary *toggle* buttons; there is no "Files" tab — returning to the default view means un-pressing the active button (`workspace/WorkspaceShell.tsx:74-126`, toggle pattern at `:84,92,100,109,118`). An intended Files tab exists as an unused i18n key `teamSpaceContentTab: 'Files'` (`i18n.ts:1220`). No `role="tablist"`/tab semantics, only `aria-pressed`. → FR-001, FR-002.
- **N2 (H)** Everything below `/team` is component state (`ProtectedSoty.tsx:63`; resolver `TeamSpace.tsx`). No deep links; browser Back exits team mode entirely; refresh resets to the content view (`WorkspaceShell.tsx:55-60`). → FR-004.
- **N3 (M)** "Change space" sits as a peer button among content views; space identity (h1) is display-only (`WorkspaceShell.tsx:76-124`). → FR-003.
- **N4 (M)** Single-space users are forced through a one-card lobby by an explicit 002 decision flagged for later revision (`specs/002-team-space-guided-flow/spec.md` Assumptions, "єдина команда" note). → FR-005.
- **N5 (L)** Wizard step 2 has no Back to the name step (`create/ConnectFolderStep.tsx:200-204`); `teamCreateBack` (`i18n.ts:1215`) is defined and unused. → FR-006.

## F. File management

- **F1 (H)** The search view — the only surface with full file actions — is gated on `hasContent`, which is set from the item count of the *currently viewed folder* (`WorkspaceShell.tsx:104` gate; `:68-70` ← `catalog/MaterialBrowser.tsx:63`). A space whose root holds only subfolders never shows search, filters, or any file management. → FR-008.
- **F2 (H)** Rename/move/download/trash/process/new-version live *only* in that search view, behind a per-row `<details>` "More actions" (`catalog/MaterialResults.tsx:161-175` → `catalog/MaterialActions.tsx:266-355`). The default file browser offers only Preview / Copy link / Create task (`MaterialBrowser.tsx:152-181`). Rename = 5+ steps through a conditionally invisible view. → FR-007.
- **F3 (H)** Catalog search has `page`/`setPage` state and `pageSize: 50` but renders no pagination control — results beyond 50 are unreachable (`catalog/useCatalogSearch.ts:87,170-171`; no control in `TeamCatalog.tsx`). → FR-010.
- **F4 (M)** Three flows ask for a raw Drive folder ID in a text field while a visual folder browser already exists (`drive/DriveFolderBrowser.tsx`): move destination (`MaterialActions.tsx:403-406`), process output (`processing/ProcessMaterialDialog.tsx:123-126` — opens pre-showing the error "Choose a destination folder." with Start disabled and no picker, because `TeamCatalog.tsx:223` passes `destinationFolderId={null}`), save-text-as-new-version (`TeamCatalog.tsx:371-374`). → FR-009.
- **F5 (M)** `MaterialBrowser` never receives the realtime `revision` prop, so the file tree ignores live catalog events; only manual folder navigation refetches (`WorkspaceShell.tsx:184`). → FR-011.
- **F6 (L)** Dead/unreachable UI: task drag-selection is fully wired but never enabled (`MaterialBrowser.tsx:37-40,113-148`; `tasks/TaskAttachmentPicker.tsx:227-235` still advertises the drop target); "Upload new version" requires a `destinationFolderId` no caller passes (`MaterialActions.tsx:284`); "Replace exact file" on conflict requires a `replaceMaterialId` never passed (`MaterialActions.tsx:420`); restore path unreachable (see R2). Wire or remove during the US2 rework. → FR-007.

## S. Feedback & status

- **S1 (H)** Team mode never uses the app's toast system (`App.tsx:132-137`). Raw machine codes render in place of human copy: `MaterialActions.tsx:448-450` (rendered at `:435-439`), `ProcessMaterialDialog.tsx:140-144`, `library/LibraryShareActions.tsx:151`, `catalog/TeamTextEditor.tsx:105-109`, `processing/OperationStatus.tsx:34`, `members/TeamAuditPanel.tsx:73`, interpolated into copy at `library/BulkUploadDialog.tsx:380,393` and `library/ProcessLibraryDialog.tsx:422`. → FR-013, FR-014.
- **S2 (H)** Silent no-op controls: "Provenance" has no `.catch` — a rejected fetch does nothing forever (`TeamCatalog.tsx:168-172`), and an empty result renders an overlay containing only a Cancel button (`preview/ProvenancePanel.tsx:22` returns null); "Edit text" silently returns unless the transcript is `full` (`TeamCatalog.tsx:105-116`). → FR-015.
- **S3 (M)** Bare "…" loaders with no label: `lobby/SpaceLobby.tsx:31`, `MaterialBrowser.tsx:91`, `MaterialResults.tsx:51`, `TeamCatalog.tsx:312` (a just-started process renders as a lone inline "…"). The access check renders a blank dimmed screen with no spinner or text (`TeamSpace.tsx:151-158`). → FR-016.
- **S4 (H)** Sync status contradicts itself: `syncLabel` hardcodes "Catalog is up to date" whenever the connection state is `connected` (`WorkspaceShell.tsx:194`) while the banner above may say "Syncing…"; `SyncProgress` renders *nothing* for `failed`/`unavailable` (`SyncProgress.tsx:13-18,49`) — a failed sync's only trace is a small string inside the conditionally hidden search view (`MaterialResults.tsx:62`). → FR-017.
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

- **C1 (H)** Two incompatible dialog systems. 14 surfaces use `components/Modal` (portal, focus trap, Escape, scroll lock, z-index 100). 7 are hand-rolled `position:fixed` overlays with **no portal, no focus trap, no Escape, no scroll lock, and no backdrop**: `ProcessMaterialDialog.tsx:89`, `TeamTextEditor.tsx:66`, `TeamCatalog.tsx:244,314,369`, `preview/MaterialPreview.tsx:199`, `landings/LandingFullView.tsx:79` (overlay style `styles.css:10591-10607`, z-index 45). The page behind stays scrollable and clickable, so overlays stack into dead layers; preview z-index 80 < modal 100, so a preview opened while a Modal is up renders *underneath* it (`styles.css:10285-10293` vs `:5680`). `MaterialPreview`/`LandingFullView` claim `aria-modal="true"` without implementing modality. `TeamCatalog` juggles 7 mutually-exclusive overlay booleans with no single overlay state (`TeamCatalog.tsx`). → FR-029.
- **C2 (M)** Vocabulary drift across one screen and both locales: space/team/workspace in a single header (`WorkspaceShell.tsx:76-124`; `i18n.ts:1194-1195`); file/material/asset/media/creative for the same object (`i18n.ts:943` "Materials", `:1222` "TEAM MEDIA", `LibraryAssetSummary`, `teamCatalogFile`); "Creative Library" as nav label vs "Library" as panel title vs "Library" as a *stage inside it* (`i18n.ts:1221,1223`; `CreativeLibrary.tsx:178-203`); tasks-vs-jobs; three distinct Cancel keys with `teamFileCancel` used as a *Close* label (`i18n.ts:883,1128,1216`; used at `ProcessMaterialDialog.tsx:97`, `TeamTextEditor.tsx:73`, `TeamCatalog.tsx:246`); uk locale uses transliterated slang "Таски" against an otherwise formal register (`i18n.ts:2753,2770,2792`); `teamTaskLoading` ("Loading task…", singular) reused for the task list and the picker's folder listing (`TaskSpace.tsx:151`, `TaskAttachmentPicker.tsx:294`). → FR-030, FR-031.
- **C3 (H, verified)** The waitlist gate title — the first thing every non-allowlisted user sees at `/team` — is the placeholder `'ДОНТ ПУШ ЗЕ ХОРСИС'` in **both** the en and uk bundles (`i18n.ts:872`, `:2291`). Verified by grep during this audit. → FR-030.

## B. Background work

- **B1 (H)** Closing the batch-processing dialog cancels the in-flight batch: unmount → `releaseActive()` → cancel (`library/ProcessLibraryDialog.tsx:459-465`). The 135-line job-claim loop lives inside the dialog component itself (`:213-348`), so the work cannot outlive the window, and no persistent progress affordance exists in the shell. → FR-032.

## P. Performance & layout (weak-hardware relevance)

- **P1 (M)** A full search page mounts up to 50 *live* `MaterialActions` instances (476 lines, 8 state hooks, file inputs each) inside always-in-DOM `<details>` elements (`MaterialResults.tsx:64-179`). → SC-009.
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
