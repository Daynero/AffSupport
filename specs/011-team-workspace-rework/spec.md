# Feature Specification: Team Workspace That Works

**Feature Branch**: `011-team-workspace-rework`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Командний режим не працює належним чином, я навіть сам не можу підʼєднати гугл диск щоб побачити всі вкладеності папки. превью не готуються і не показуються, не допродуманий функцціонал юай і UX, треба переосмислити і доробити. Зробити зручно і швидко, а головне щоб це працювало! Нічого мене поки не питай, розписуй сам як знаєш, не бійся щось в UI пропонувати змінювати навіть координально, головне щоб було зручно."

## Overview

Team mode was specified across four features (001, 004, 005, 010) and carries hundreds of
completed tasks, yet the person who owns the product cannot connect a storage folder and see
what is inside it. This feature does not add a fifth layer. It takes the one journey that
every other team capability depends on — **connect storage, see everything in it, see what
each file looks like** — and makes it work, fast, on the production site, for a real team.

Everything else in team mode is secondary until that journey holds. Where the existing
interface stands in the way of that journey, this feature changes the interface, including
its top-level shape.

Throughout this document, **the storage provider** means the external cloud storage a team
connects (today: Google Drive), **the root** means the one folder a team connects as its
shared storage, **the local app** means the part of Soty installed on a member's computer,
and **the interface** means the part that runs in the browser.

### What is observed today

These are facts gathered from the codebase, its records and production analytics on
2026-08-27, not guesses. Each shaped a requirement below.

1. **Nobody has ever completed the team journey in production.** Across the product's whole
   life, one account has had a team session. The first-run setup criterion (SC-001 of
   feature 001) shows 14 attempts and 0 successes. Finding a given material succeeds 50% of
   the time against an 18-of-20 target. Feature 010's own closing record lists every
   storage-dependent flow — rename, move, trash, restore, search over a real page of results,
   background processing — as "still could not cover" because no real storage was ever
   attached during verification.
2. **The production storage connection depends on a provider review that was never
   requested.** The product's own release notes for the provider integration state that the
   shared-storage capability is "deliberately not ready for submission" and must stay so
   "until the complete user journey works in production", while the production deployment is
   configured as if that review had passed. The practical result for an owner today: the
   provider's consent screen warns that the application is unverified, only pre-listed test
   accounts may consent at all, and the access it grants expires within days. A connection
   that appears to succeed then quietly stops working, and every preview behind it stops
   with it. This is the most likely reason the owner "cannot connect the storage".
3. **The folder view is one level deep.** The storage browser fetches one folder's children
   per request with a "load more" control and no tree; the catalog browser cannot rebuild a
   breadcrumb for the folder it is showing. Nesting — the thing the owner asked to see —
   is exactly what the interface does not show.
4. **Previews are produced only when opened, and rows have none.** Material lists show no
   thumbnails at all. Opening a preview starts the work from zero; archives and landing
   pages additionally require the local app to be running on the viewer's machine. A member
   scrolling a folder of creatives sees file names only, which for a media-buying team is
   the same as seeing nothing.
5. **The team surface is split into six top-level areas** — Files, Landings, Library, Tasks,
   Members, Settings — three of which (Files, Landings, Library) are different windows onto
   the same storage. The split was designed before the storage worked; it multiplies the
   places a person must look and the code that must be right.

### Decisions this specification makes

The owner asked not to be asked. These decisions are recorded here so planning does not
reopen them; any one can be overturned by the owner in review.

- **D1 — The storage connection is redesigned around explicit root selection by the owner,
  and the product must not depend on a restricted-scope provider review to work in
  production.** The owner chooses the root in the provider's own folder chooser; Soty then
  works on everything under that root. If the plan proves that a chosen root does not carry
  its descendants under a non-restricted access grant, the release still ships on explicit
  selection — the owner selects one or more folders, and what is selected is indexed — while
  the restricted-scope review is submitted in parallel as a tracked, non-blocking external
  dependency; once approved, the full tree is reached without re-selection. The interface,
  the sync and the previews are built the same way in either case, so no work waits on the
  review (clarified 2026-08-27).
- **D2 — Previews are prepared ahead of use and are shared team assets.** They are produced
  in the background after a folder is indexed, stored where every member can see them, and
  shown in every list and grid. A member who has never installed the local app sees the same
  thumbnails as one who has.
- **D3 — Files, Landings and Library merge into one explorer.** One folder tree, one content
  area, one search, one preview pane, with "landings", "creatives", "videos", "transcripts"
  and "archives" as filters on that explorer rather than separate destinations. Tasks and
  Members remain secondary areas; Settings folds into the space header. This is the radical
  change the owner allowed, chosen because it removes three duplicate surfaces rather than
  polishing them.
- **D4 — Indexed data answers first, the provider answers second.** Opening a folder a member
  has already indexed shows its contents from the index immediately; the provider is
  consulted in the background and differences are reconciled visibly. The provider is never
  on the critical path of a click.
- **D5 — The success criteria are ones a single person can run.** Feature 001's cohorts of
  twenty were never assembled and never will be for this pass. Every criterion below is
  verifiable by the owner, on production, with one real storage account, in an afternoon.

## Clarifications

### Session 2026-08-27

- Q: If planning shows that explicit root selection (D1) cannot reach nested files without
  the provider's restricted-scope review, what happens? → A: Both in parallel — release on
  explicit selection (owner selects one or more folders; what is selected is indexed) and
  submit the restricted-scope review in the background; after approval the full tree is
  reached without re-selection. The review never blocks the release.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect storage once and see the whole tree (Priority: P1)

A team owner signs in on the production site, creates a space, chooses one folder in their
storage account as the root, and within minutes sees the complete folder tree under it —
every nested level, with file counts — and can open any folder at any depth. Thirty days
later, without having touched the connection, the tree still opens.

**Why this priority**: This is the failure the owner reported first and the one every other
team capability sits on. Nothing downstream can be judged until this holds.

**Independent Test**: On the production site, with a storage account containing a root of at
least 500 files across at least four levels of nesting, connect the root and confirm that the
tree shown matches the provider's own view level for level; return after 30 days and confirm
the connection still works with no action taken.

**Acceptance Scenarios**:

1. **Given** a signed-in owner with no space, **When** they create a space, **Then** the only
   required steps are a name and a root choice, the root is chosen in the provider's own
   folder chooser, and the space opens immediately afterwards — no further wizard step.
2. **Given** a root was just connected, **When** the owner looks at the space, **Then** they
   see indexing progress as a live count ("1,240 files so far · 37 folders remaining") and the
   folders indexed so far are already openable while the rest are still arriving; a total is
   shown only once the provider has been walked completely and reconciliation knows it.
3. **Given** the root is indexed, **When** the owner expands any folder in the tree,
   **Then** its child folders appear within one second, at any depth, and the current
   location is always shown as a full path from the root that can be clicked at any segment.
4. **Given** a folder contains more than 1,000 direct children, **When** it is opened,
   **Then** the first screen appears within one second and the rest arrive as the member
   scrolls, with the total count shown from the start.
5. **Given** the connection was made 30 days ago and no member has done anything about it,
   **When** any member opens the space, **Then** it works without reconnection.
6. **Given** the provider's consent screen is shown to the owner, **Then** it shows the
   product's own name and no "unverified" warning, and any Google account may consent —
   not only pre-listed test accounts.
7. **Given** the owner's storage account contains items that are not plain files and folders
   (shortcuts, provider-native documents, items in a shared drive), **When** they appear
   under the root, **Then** each is shown with a clear kind and either works or explains in
   one line why it does not — never a blank row or an error.

---

### User Story 2 - Previews are ready before you ask (Priority: P2)

A member opens a folder of creatives and sees a grid of thumbnails, not names. Hovering or
selecting a video shows a poster frame and duration; an image shows itself; a landing
archive shows a screenshot of the landing. Opening any of them shows something useful within
two seconds. Previews are prepared in the background after indexing and never require the
member to have the local app running.

**Why this priority**: The owner reported "previews are not prepared and not shown" as the
second failure. For a media-buying team the thumbnail *is* the file; without it the catalog
is a directory listing.

**Independent Test**: Connect a root with at least 100 images, 50 videos and 10 landing
archives; wait for preparation to report complete; scroll the folders and confirm every
supported item has a thumbnail; open 20 items of each kind cold and time the first useful
frame.

**Acceptance Scenarios**:

1. **Given** a folder was indexed, **When** preview preparation for it finishes, **Then**
   every image, video and landing archive in it has a thumbnail in the grid and the list, and
   preparation progress was visible the whole time as a count.
2. **Given** a member who has never installed the local app, **When** they open the same
   folder, **Then** they see the same thumbnails and can open the same previews.
3. **Given** a prepared video, **When** a member opens it, **Then** a poster frame is visible
   immediately and playback starts within two seconds on an ordinary connection.
4. **Given** a prepared landing archive, **When** a member opens it, **Then** they see the
   screenshot immediately and the interactive rendering within five seconds if the local app
   is available, or the screenshot alone with a one-line explanation if it is not.
5. **Given** a file whose kind cannot be previewed (unsupported, corrupt, encrypted,
   too large), **Then** its tile shows a kind icon and a one-line reason, and the file can
   still be downloaded and managed.
6. **Given** a file was added, replaced or renamed in the provider directly, **When** the
   space next reconciles, **Then** its preview is prepared or refreshed without anyone
   asking, and a stale preview is never shown for a changed file.
7. **Given** preview preparation is running on a member's machine, **When** that member
   sets a power limit, **Then** preparation respects it exactly as the compressor does, and
   the machine stays usable for ordinary work.
8. **Given** preview preparation was interrupted (app quit, machine slept, connection lost),
   **When** work resumes, **Then** it continues from where it stopped and nothing already
   prepared is redone.

---

### User Story 3 - One explorer instead of four sections (Priority: P3)

A member opens a space and finds one explorer: the folder tree on the left, the folder's
contents in the middle as a grid or list, and a preview pane on the right that shows whatever
is selected. Search filters what is in front of them or the whole space, on the same screen.
"Landings", "Creatives", "Videos", "Transcripts", "Archives" are one click each, as filters,
not as separate pages. Every file action — download, rename, move, trash, process, copy link —
is on the item, in its context menu and in the preview pane.

**Why this priority**: The owner called the interface "not thought through". The current
six-area layout was built around parts that did not work; once storage and previews work,
three of the six areas are the same thing. Merging them is what makes the space feel like
one tool.

**Independent Test**: Give a member who has never seen Soty a space with a real root and
ask them, without hints, to (a) find a specific landing by name, (b) find every video in one
campaign folder, (c) move a creative to another folder, (d) share a link to a file. Each is
done from the explorer without leaving it.

**Acceptance Scenarios**:

1. **Given** a member opens a space, **Then** the explorer is the first and only primary
   screen, the tree is visible, the last-visited folder is restored, and Tasks and Members are
   reachable from a secondary place without leaving the space.
2. **Given** a member selects a file, **Then** the preview pane shows it and the file's
   actions without opening a dialog; keyboard arrows move the selection and the pane follows.
3. **Given** a member types in the search box, **Then** results narrow within the current
   folder as they type, a single control widens the scope to the whole space, and every result
   shows its full path from the root.
4. **Given** a member applies a kind filter, **Then** the tree and grid show only matching
   items and folders that contain them, counts update, and the filter stays applied as they
   navigate until they clear it.
5. **Given** a member drags a file from one folder to another in the tree, **Then** the move
   happens with a visible result and an undo, following the reversibility rules from feature
   010.
6. **Given** the interface is narrower than a laptop screen, **Then** the tree collapses to
   a drawer and the preview pane to a sheet, and every action remains reachable.
7. **Given** every existing capability of the former Landings and Library areas (gallery
   tiles, full landing view, bulk upload, processing, share actions, trash view), **Then**
   each is reachable from the explorer and none was lost in the merge.

---

### User Story 4 - Storage health is always visible and self-healing (Priority: P4)

Every member can see, at a glance, whether the space's storage is connected, indexing,
preparing previews, up to date, or in need of attention. When the connection needs the owner
(access revoked, root moved or deleted, access expired), the space says so in one sentence,
names who can fix it, and the fix is one action.

**Why this priority**: The current failure is silent. A connection that stopped working looks
like an empty space. Truthful state was feature 009's fourth outcome; this extends it to the
one connection team mode depends on.

**Independent Test**: With a working space, revoke the app's access in the provider; confirm
the space reports it within one minute and the owner's one-action reconnect restores it.
Rename and then delete the root in the provider; confirm each state is reported correctly.

**Acceptance Scenarios**:

1. **Given** any space, **Then** a single storage chip is visible on every team screen with
   one of: connected and current (with time of last reconciliation), indexing (with count),
   preparing previews (with count), needs attention (with reason), or disconnected.
2. **Given** the provider stops honouring the connection, **When** any member next uses the
   space, **Then** within one minute the chip shows "needs attention", the reason is stated
   in plain words, indexed data and previews remain visible read-only, and no data is
   deleted.
3. **Given** a "needs attention" state, **When** the owner acts on it, **Then** reconnecting
   is one action, keeps the same root when it still exists, and the space returns to
   "connected" without re-indexing what has not changed.
4. **Given** the root was renamed or moved within the provider, **Then** the space follows
   it without any action; **Given** it was deleted, **Then** the space says so and offers to
   choose a new root or restore from the provider's trash.
5. **Given** the provider rate-limits or is temporarily unavailable, **Then** indexing and
   preparation pause and resume on their own, the chip says "waiting for the provider", and
   nothing is reported as failed.

---

### User Story 5 - Proof on real storage (Priority: P5)

Every storage-dependent flow that feature 010 recorded as "could not cover" is exercised
against real storage and recorded: rename, move, trash, restore, a search page of at least
50 results, background processing, and the second-account view of each. The record names
the environment, the root, the counts and the outcome, and lives with this specification.

**Why this priority**: "It works" is the owner's stated requirement. The previous four
features declared team mode done with those flows unverified; this feature does not close
until they are.

**Independent Test**: The quickstart for this feature is run end to end on the beta stack
with a real storage test account, then repeated on production with the owner's account, and
the record is complete.

**Acceptance Scenarios**:

1. **Given** the beta stack with real storage attached, **When** the quickstart is run,
   **Then** every flow listed above passes and the record shows what was done and seen.
2. **Given** a second member account, **When** the owner performs each flow, **Then** the
   second account sees the result within ten seconds without reloading, and the reverse
   holds.
3. **Given** the production site, **When** the owner repeats the quickstart with their own
   storage, **Then** it passes; any deviation from the beta run is recorded as a finding
   with its cause.

---

### Edge Cases

- A root containing more than 50,000 files: indexing continues in the background across
  sessions, the tree remains usable throughout, and the published limit is stated where the
  count is shown rather than hit silently.
- A single folder with 10,000 direct children: paging from the first screen, count from the
  start, search within the folder still works.
- Two members with different provider accounts: all storage operations go through the space's
  one connection (decision from feature 001); a member's own provider account is never asked
  for.
- The owner's provider account is removed from the organisation, or the owner leaves the
  team: the space reports "needs attention", names the new owner as the one who can
  reconnect, and keeps every index, preview and record until a replacement connection
  succeeds.
- Provider-native documents (docs, sheets, slides) inside the root: shown with their kind,
  openable in the provider, not previewable in Soty, never counted as failures.
- Shortcuts to items outside the root: shown as shortcuts, never followed outside the root.
- A file replaced in the provider while its preview is being prepared: the prepared preview
  is discarded and the new file is prepared; the old preview is never shown for the new file.
- Preview preparation on a low-powered machine: honours the power limit, never runs more than
  one heavy piece of work at once at the lowest setting, and can be paused from the chip.
- A member with the local app closed opens a landing archive: the screenshot is shown, the
  explanation is one line, and the archive's manifest is still listable.
- Search for a term that matches 5,000 files: the first page appears within one second,
  the count is shown, and narrowing by folder or kind is one click.
- The interface is reloaded mid-indexing: progress is restored from the space, not from the
  browser, and nothing restarts from zero.
- Two members trigger preparation of the same folder: it is prepared once; both see progress.

## Requirements *(mandatory)*

### Functional Requirements

**Connecting storage**

- **FR-001**: An owner MUST be able to create a space and connect its root in a single flow
  consisting of exactly two inputs — a name and a root chosen in the provider's own folder
  chooser — after which the space opens without further steps.
- **FR-002**: The production storage connection MUST work for any provider account, MUST
  present the product's own name on the provider's consent screen without an "unverified"
  warning, and MUST NOT depend on the provider's restricted-scope review to be usable (D1).
  If planning proves the chosen access model cannot reach a root's descendants, the release
  MUST ship on explicit selection — the owner selects one or more folders in the provider's
  chooser and exactly those are indexed, previewed and managed — and the restricted-scope
  review MUST be submitted in parallel as a tracked external dependency that blocks no
  interface, indexing or preview work. After approval, the space MUST reach the full tree
  under the original root without the owner re-selecting anything.
- **FR-003**: A connection MUST remain valid for at least 90 days without any member action,
  and MUST be renewed silently for as long as the provider allows.
- **FR-004**: When a connection stops working for any reason, the space MUST report it within
  one minute of the next use as a "needs attention" state with a plain-language reason, MUST
  name who can fix it, MUST keep all indexed data and previews visible read-only, and MUST
  delete nothing until a replacement connection succeeds.
- **FR-005**: Reconnecting MUST be one action, MUST keep the existing root when it still
  exists, and MUST NOT re-index unchanged content.
- **FR-006**: The space MUST follow its root through renames and moves within the provider
  without any action, and MUST report deletion of the root with the options of choosing a new
  root or restoring the old one from the provider's trash.

**Seeing everything**

- **FR-007**: After a root is connected, Soty MUST index every folder and file at every depth
  under it, MUST show progress as a live count of files indexed so far and folders still
  queued (the provider does not report a total in advance; "N of M" appears only during
  reconciliation, where M is known), and MUST make folders openable as soon as they are
  indexed rather than after indexing completes.
- **FR-008**: The explorer MUST show the complete folder tree under the root, expandable to
  any depth, with a per-folder count, and MUST show the current location as a full clickable
  path from the root.
- **FR-009**: Opening any indexed folder MUST show its first screen of contents within one
  second from the index, regardless of the provider's availability, and MUST reconcile
  against the provider in the background with any difference applied visibly (D4).
- **FR-010**: Folders with more than one screen of children MUST page as the member scrolls,
  with the total shown from the start; the first screen MUST never wait for the last.
- **FR-011**: Every item under the root MUST be shown with a clear kind — folder, image,
  video, landing archive, other archive, transcript, provider-native document, shortcut,
  other — and non-file kinds MUST either work or state in one line what they cannot do.
- **FR-012**: Indexing MUST survive interface reloads, sign-outs and local app restarts,
  resuming from the space's own record rather than from the browser.
- **FR-013**: Changes made in the provider directly (add, replace, rename, move, trash,
  restore) MUST appear in the space within the reconciliation interval, and that interval
  MUST be shown at the storage chip as the time of last reconciliation.

**Previews**

- **FR-014**: After a folder is indexed, Soty MUST prepare a thumbnail for every image, video
  and landing archive in it in the background, MUST show preparation progress as a count, and
  MUST show each thumbnail in every list and grid as soon as it exists (D2).
- **FR-015**: Prepared previews MUST be shared team assets: any member of the space MUST see
  them in the browser without running the local app.
- **FR-016**: Opening a prepared image MUST show it immediately; a prepared video MUST show
  its poster frame immediately and begin playback within two seconds on an ordinary
  connection (at least 10 Mbps down, 50 ms round trip, no packet loss — the same reference as
  feature 001's SC-006); a prepared landing archive MUST show its screenshot immediately and, when the
  local app is available, its interactive rendering within five seconds.
- **FR-017**: A file that cannot be previewed MUST show its kind and a one-line reason —
  unsupported, corrupt, protected, too large — and MUST remain downloadable and manageable.
- **FR-018**: Preview preparation that runs on a member's own machine (landing renders) MUST
  respect that member's power limit exactly as the compressor does, MUST be pausable from the
  storage chip on that machine, MUST resume after interruption from where it stopped, and MUST
  never redo work already recorded as complete. Preparation that runs on Soty's own backend
  (image and video thumbnails from the provider) loads no member's machine and needs no pause;
  it MUST still resume and never redo completed work.
- **FR-019**: A preview MUST be invalidated and re-prepared when its file changes in the
  provider; a stale preview MUST never be shown for a changed file.
- **FR-020**: When several members could prepare the same folder, it MUST be prepared once,
  and all of them MUST see the same progress.

**One explorer**

- **FR-021**: The space MUST present one primary screen — the explorer — consisting of the
  folder tree, the content area (grid or list, member's choice remembered), and a preview
  pane for the selected item (D3).
- **FR-022**: Every capability of the former Files, Landings and Library areas MUST be
  reachable from the explorer — gallery tiles, full landing view, bulk upload, processing,
  share and copy-link actions, trash view, metadata editing, provenance — and none MUST be
  lost in the merge.
- **FR-023**: Kind filters — landings, creatives (images), videos, transcripts, archives —
  MUST be single-click, MUST filter both tree and content, MUST update counts, and MUST
  persist while navigating until cleared.
- **FR-024**: Search MUST narrow the current folder as the member types, MUST widen to the
  whole space with one control, MUST show the full path of every result, and MUST return its
  first page within one second for a space at the published 50,000-material limit.
- **FR-025**: Every file action — download, rename, move, trash, restore, process, copy link,
  edit metadata — MUST be available on the item's context menu and in the preview pane, and
  MUST follow the visible-result and reversibility rules of feature 010.
- **FR-026**: Moving items MUST be possible by dragging within the tree and content area, with
  a visible result and an undo.
- **FR-027**: Keyboard navigation MUST cover the tree, the content area and the preview pane:
  arrows move selection, Enter opens, Escape closes, and the preview follows selection.
- **FR-028**: On narrow screens the tree MUST collapse to a drawer and the preview pane to a
  sheet, with every action still reachable; the explorer MUST be usable at 320 px width.
- **FR-029**: Tasks and Members MUST remain reachable from a secondary place without leaving
  the space; Settings MUST fold into the space header. No team screen other than the
  explorer, Tasks and Members MUST exist as a top-level destination.
- **FR-030**: The last-visited folder, view mode and filters MUST be restored when a member
  returns to a space.

**Storage health**

- **FR-031**: A single storage chip MUST be visible on every team screen and MUST show
  exactly one of: connected and current (with last reconciliation time), indexing (with
  count), preparing previews (with count), waiting for the provider, needs attention (with
  reason), or disconnected.
- **FR-032**: Provider rate limits and temporary outages MUST pause and resume indexing and
  preparation automatically, MUST be shown as "waiting for the provider", and MUST NOT be
  reported as failures.

**Proof**

- **FR-033**: The feature's quickstart MUST exercise, against real storage, every flow feature
  010 recorded as uncovered — rename, move, trash, restore, a search page of at least 50
  results, background processing — and each from a second member account, and MUST record
  environment, root, counts and outcomes in this feature's directory.
- **FR-034**: The quickstart MUST be run on the beta stack with real storage and then on
  production with the owner's account before the feature is considered complete.
- **FR-035**: Team analytics MUST record, for each space, first-run completion, indexing
  completion, preview-preparation completion and connection-attention events, so the
  criteria below can be read from the existing analytics tooling without new manual counting.

### Key Entities *(include if feature involves data)*

- **Storage connection**: a space's one link to its provider account; has a state (connected,
  needs attention, disconnected), a last-reconciliation time, and the identity of the member
  who can renew it.
- **Root**: the one provider folder a space is built on; followed by identity, not by name or
  path, so renames and moves do not break it.
- **Folder node**: an indexed folder under the root; knows its parent, its direct child
  counts by kind, and whether its children have been fully indexed.
- **Material**: an indexed file under the root; has a kind, provider identity, current
  version marker, parent folder, and preview state.
- **Preview**: a prepared thumbnail/poster/screenshot for one material version; shared by the
  space; has a state (pending, preparing, ready, unavailable with reason) and is tied to the
  version it was prepared from.
- **Index pass**: one background walk of the root or a reconciliation of part of it; has
  progress counts, a resumable position, and an outcome.
- **Preparation pass**: one background run of preview preparation over a folder; has progress
  counts and a resumable position. Image and video thumbnails are prepared on Soty's backend
  from the provider's own thumbnails; landing renders are prepared by the local app of a
  member who has it running, recorded with that member, and honour that member's power limit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the production site, the owner connects a real root containing at least 500
  files across at least four levels of nesting, and the complete tree — every level, every
  count — matches the provider's own view within five minutes of connecting, on the first
  attempt, with no support.
- **SC-002**: Thirty days after connecting, with no member action in between, the space opens
  and works; over the same period the analytics record zero connection-attention events for
  that space that were not caused by a deliberate revocation.
- **SC-003**: Opening any indexed folder shows its first screen within one second in 95 of
  100 consecutive openings across at least 20 distinct folders, including 5 with more than
  1,000 children, measured with the provider deliberately unreachable.
- **SC-004**: After preparation reports complete for a root with at least 100 images, 50
  videos and 10 landing archives, 100% of them show a thumbnail in the grid, and in 60 cold
  openings (20 of each kind) a useful first frame is visible within two seconds in at least
  57.
- **SC-005**: A member who has never installed the local app sees every thumbnail and opens
  every prepared image and video that the owner can.
- **SC-006**: Three people who have never seen Soty, given a real space and no hints, each
  complete all four explorer tasks — find a landing by name, list every video in a folder,
  move a creative, copy a share link — without leaving the explorer, and each in under
  three minutes total.
- **SC-007**: Revoking the app's access in the provider is reported by the space within one
  minute of the next use, and the owner's single reconnect action restores full function
  without re-indexing, in three of three trials.
- **SC-008**: Every storage-dependent flow feature 010 listed as uncovered passes on the beta
  stack against real storage and again on production, with a written record of each run in
  this feature's directory.
- **SC-009**: With the power limit at its lowest setting and preview preparation running on
  the owner's own machine, ordinary work (browsing, editing, a video call) proceeds without
  perceptible slowdown, and the machine's measured load stays under the same ceiling the
  compressor honours.
- **SC-010**: Every screen and state introduced here passes the accessibility, i18n and
  design-token gates that features 009 and 010 established, with no new baseline exceptions.

## Assumptions

- The provider remains Google Drive for this feature; no second provider is introduced.
- A space keeps one shared storage connection, as decided in feature 001; members are never
  asked for their own provider account.
- The published limits from `docs/TEAM_WORKSPACE_OPERATIONS.md` (50 members, 50,000
  materials, transfer and archive bounds) stand; this feature makes them visible where they
  apply rather than raising them.
- Image and video thumbnails are prepared on Soty's backend from the thumbnails the storage
  provider already produces, stored as a shared, access-controlled asset of the space, and
  need no member's local app. Landing renders are prepared by the local app of a member who
  has it running; when none is running, landing tiles wait and the chip says so. The
  constraint from this specification is that any member sees prepared previews in the
  browser and that no file content leaves the provider and the space's own storage.
- The reconciliation interval is five minutes and is shown on the storage chip rather than
  hidden.
- A space's tree is bounded at 10,000 folders (a published limit alongside the 50,000
  materials); beyond it the tree read reports the limit instead of truncating silently.
- Tasks (feature 001/010) and membership (feature 010) keep their behaviour; this feature
  moves their entry points and changes nothing inside them.
- The landing optimizer and the individual (non-team) tools are out of scope.
- The existing catalog data model and its search index are reused where they fit; the plan
  may extend them and must not fork them.
- **Delivery constraint from the owner**: implementation and verification on the owner's
  machine proceed in small, sequential steps — one build, one suite, one check at a time —
  with the machine's load checked before each heavy step and no parallel heavy processes.
  Preview preparation, in particular, must be designed so that its own development testing
  does not exceed the lowest power-limit setting on that machine.
- Any decision in "Decisions this specification makes" can be overturned by the owner during
  review; until then it is fixed and planning does not reopen it.
