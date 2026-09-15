# Feature Specification: Catalog Updater

**Feature Branch**: `023-catalog-updater` (cut from `022-video-catalog-sheet`)

**Created**: 2026-09-15

**Status**: Draft

**Input**: Owner's description, 2026-09-15, condensed:

> A catalog updater, built on feature 022's catalogs. It opens as a full-screen dialog where it is
> configured; once started and closed, it sits as a small panel near the space settings, showing a
> live timer, that the updater is running, and how many catalogs it is updating. In its settings
> you pick — by search or by scrolling and ticking — catalogs out of all catalogs that exist. That
> needs a registry of every catalog: every sheet we created, tied to its video, recorded so it can
> be managed. You tick catalogs, choose an interval — one hour, one day or one week — and start. When
> the interval elapses, every product ID in each sheet is rewritten by an algorithm that always gives
> unique IDs within one sheet (for example, add 500 to each ID — open to a better proposal). If a
> "re-stitch video" option is on, the catalog's video is re-stitched, placed next to the original,
> and the sheet's video link points at the re-stitched copy. Re-stitching happens ahead of time: as
> soon as the updater starts, a re-stitched copy is prepared, so when the interval elapses it is
> ready to swap in. Each iteration re-stitches the original again; when the new copy is ready and
> the interval elapses, it replaces the previous one in the sheet and the previous copy is deleted.
> Only one spare re-stitched copy ever exists per catalog. If the updater is stopped, the spare copy
> is deleted.

## Why This Exists

A product catalog built by feature 022 is a feed that ad platforms read again and again. Keeping it
looking fresh today would mean re-creating each catalog by hand — and re-creating changes the sheet
link the platform is already pointed at. The owner wants the same sheets, at the same links, to
renew themselves on a schedule: new product IDs every interval and, when wanted, a freshly
re-stitched video behind every product — with no pile of old video copies left behind.

## What already exists and constrains this feature

These facts from the code shape the requirements; the plan owns the detail.

- **Catalogs are already recorded.** Feature 022 keeps one record per sheet (`team_product_catalogs`)
  and links the live sheet to its video. The registry this feature needs is a view over that, not a
  new store.
- **Re-stitching runs only on a member's computer**, in the desktop app, using that computer's screen
  image library; the space stores only which images to use (feature 015). Today it runs only from an
  open browser tab and saves the result to a local folder — it never uploads to Google Drive, and the
  desktop app never takes work from the server on its own. Feature 015 listed automatic re-stitching
  as out of scope; this feature brings it in.
- **The server can run work on a schedule** (the space's catalog sync already does), so rewriting
  sheets on time does not depend on anyone being online.
- **Consequence:** rewriting IDs can ship as a server and web change, but automatic re-stitching needs
  a new version of the desktop app. The owner has accepted that the desktop apps will be reworked.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - See and manage all catalogs (Priority: P1)

A member opens the catalog updater and sees every catalog in the space in one list — which video
it belongs to, where that video is, how many products it has, when it was created and last updated,
and whether it is in the running updater — and can find one by search, open it, or copy its link.

**Why this priority**: Every other story selects from this list. It is also useful on its own: today
a catalog can only be found by opening its video.

**Independent Test**: With several catalogs across folders, open the updater, find a catalog by part
of its video's name, open its sheet and copy its link.

**Acceptance Scenarios**:

1. **Given** a space with catalogs in several folders, **When** a member opens the updater, **Then**
   every live catalog appears once, showing its video name, the video's folder, product count,
   created date, last update, and whether the updater includes it.
2. **Given** the list, **When** the member types part of a video or catalog name, **Then** only
   matching catalogs remain, and clearing the search brings the rest back.
3. **Given** a catalog in the list, **When** the member chooses to open it or copy its link,
   **Then** the sheet opens in a new tab or its link is copied.
4. **Given** a catalog whose sheet or video was deleted, **When** the list is shown, **Then** that
   catalog is not offered.

---

### User Story 2 - Start an updater (Priority: P1)

A member ticks catalogs (one by one, or all that match a search), chooses an interval — 1 hour,
1 day or 1 week — optionally turns on "re-stitch video", and starts. The dialog can then be closed;
the updater keeps running whether or not anyone has the space open.

**Why this priority**: This is the feature.

**Independent Test**: Tick two catalogs, choose 1 hour without re-stitching, start, close the
browser; after the hour, open both sheets at their existing links and see new product IDs.

**Acceptance Scenarios**:

1. **Given** the updater dialog, **When** the member ticks catalogs, **Then** a running count of the
   selection is shown, and "select all" selects exactly the catalogs matching the current search.
2. **Given** a selection, **When** the member chooses an interval, **Then** exactly three choices
   are offered: 1 hour, 1 day, 1 week.
3. **Given** a selection and an interval, **When** the member starts, **Then** the updater is
   running, the dialog shows the time until the first update, and closing the dialog leaves it
   running.
4. **Given** nothing is ticked, **When** the member tries to start, **Then** starting is not
   possible and the dialog says why.
5. **Given** a running updater, **When** everyone closes the space, **Then** updates still happen on
   time.

---

### User Story 3 - The panel (Priority: P1)

While the updater runs, a small panel beside the space settings shows that it is running, a live
countdown to the next update, and how many catalogs it updates. Clicking it reopens the full-screen
dialog.

**Why this priority**: Without it a running updater is invisible, and people will start a second
one or forget one is running.

**Independent Test**: Start an updater, close the dialog, watch the panel count down a minute, click
it and land back in the dialog.

**Acceptance Scenarios**:

1. **Given** a running updater, **When** any member views the space, **Then** the panel shows
   "running", the time to the next update counting down each second, and the number of catalogs.
2. **Given** re-stitching is on and copies are still being prepared, **When** the panel is shown,
   **Then** it also shows how many of the catalogs have their next video ready.
3. **Given** something needs attention (for example the re-stitching computer is offline, or a sheet
   could not be updated), **When** the panel is shown, **Then** it shows an attention state, and the
   dialog says what and for which catalogs.
4. **Given** no updater is running, **When** the space is shown, **Then** there is no panel.

---

### User Story 4 - Change or stop a running updater (Priority: P2)

A member reopens the dialog of a running updater to add or remove catalogs, change the interval,
switch re-stitching, or stop it.

**Why this priority**: A long-running process must be controllable; it follows starting it.

**Independent Test**: Remove one catalog and add another to a running updater, then stop it; check
which sheets changed at the next interval and that no spare re-stitched copies remain.

**Acceptance Scenarios**:

1. **Given** a running updater, **When** a catalog is added, **Then** it is updated from the next
   update on (and, with re-stitching on, its first copy starts being prepared at once).
2. **Given** a running updater, **When** a catalog is removed, **Then** it is not updated again, and
   its spare re-stitched copy, if any, is deleted.
3. **Given** a running updater, **When** the interval is changed, **Then** the countdown restarts
   from the moment of the change.
4. **Given** a running updater, **When** it is stopped, **Then** no further updates happen, the panel
   disappears, every spare re-stitched copy is deleted, and each sheet keeps pointing at the video it
   pointed at last.

---

### User Story 5 - Re-stitched videos behind the catalog (Priority: P2)

With "re-stitch video" on, each catalog always has one re-stitched copy of its video prepared ahead
of the next update. At each update the sheet's video links switch to that copy, the copy the sheet
used before is deleted, and a new copy starts being prepared from the original video.

**Why this priority**: It is the most valuable part of an update and the most expensive; it depends
on a desktop app release, so it is sequenced after the server-side updates that can ship first.

**Independent Test**: Start with re-stitching on and a 1-hour interval; right after starting, a
re-stitched copy appears next to the video; after the hour, the sheet's video links open that copy,
a new copy is being prepared, and at no time are there more than two re-stitched copies of that
video (the one in the sheet and the spare).

**Acceptance Scenarios**:

1. **Given** re-stitching is on, **When** the updater starts or a catalog is added, **Then**
   re-stitching of that catalog's original video starts immediately, and the copy is placed next to
   the original video.
2. **Given** a spare copy is ready, **When** the interval elapses, **Then** every product row's video
   link in that sheet points at the spare copy (still distinct per row), the copy previously used by
   the sheet is deleted, and re-stitching of the original starts again for the next update.
3. **Given** the spare copy is not ready when the interval elapses, **When** the update runs,
   **Then** IDs are still rewritten, the video links keep their current target, and the panel shows
   that this catalog's video was not refreshed.
4. **Given** re-stitching is always done from the original video, **When** several updates have run,
   **Then** no copy is ever a re-stitch of a re-stitch.
5. **Given** the updater is stopped or the catalog removed, **When** a spare copy exists or is being
   prepared, **Then** preparation is cancelled and the spare copy is deleted.
6. **Given** re-stitching is switched off on a running updater, **When** the next update runs,
   **Then** links keep pointing at the copy in use, spare copies are deleted, and no new ones are
   prepared.

---

### Edge Cases

- **The re-stitching computer is off, asleep or offline** at the moment a copy is needed: preparation
  waits for it; updates run on time without a fresh video (US5 scenario 3); the panel shows attention.
- **The space has no re-stitch defaults**, or that computer lacks the screen images they name:
  re-stitching cannot be turned on (or is flagged per catalog), with the reason shown.
- **A catalog's sheet is deleted, trashed or edited by hand in Drive**: the next update does not
  recreate it; the catalog leaves the updater and the dialog says so. A hand edit is overwritten by
  the next update (the sheet is generated).
- **A catalog's video is deleted or trashed**: the catalog leaves the updater; spare copies are
  deleted.
- **A catalog is re-created (feature 022) while in the updater**: the new sheet takes the old one's
  place in the updater.
- **Drive is disconnected** or a Drive call fails: the update is retried; after repeated failure the
  catalog shows an error and the panel an attention state; other catalogs are unaffected.
- **Two members open the dialog at once**: there is one updater per space; the second sees the
  running one and edits it, and the later save wins.
- **An update is overdue** (the server was unavailable): it runs once when possible, not once per
  missed interval, and the countdown continues from then.
- **Very many catalogs**: all selected catalogs are updated within a few minutes of the due time.
- **Re-stitched copies in the explorer**: they are recognisable as the updater's copies of their
  video, and deleting one by hand is treated like a missing spare.

## Requirements _(mandatory)_

### Functional Requirements

**Catalog registry**

- **FR-001**: The system MUST list every live catalog in the space — one whose sheet and video both
  still exist — with video name, video folder, product count, creation date, last update time, and
  updater membership.
- **FR-002**: The list MUST be searchable by video name and catalog name, and each entry MUST offer
  opening the sheet and copying its link.
- **FR-003**: Everyone who can see the space MAY view the registry; only members allowed to process
  materials MAY start, change or stop the updater.

**The updater**

- **FR-004**: A space MUST have at most one updater, stored on the server, so it runs regardless of
  anyone being online and every member sees the same state.
- **FR-005**: Configuring the updater MUST happen in a full-screen dialog with: the catalog list with
  ticks (individually and "select all matching"), the interval (exactly 1 hour, 1 day, 1 week), the
  "re-stitch video" option, and start / save changes / stop.
- **FR-006**: Starting MUST require at least one ticked catalog; the first update is due one interval
  after start.
- **FR-007**: At each due time the system MUST update every catalog in the updater in place — the same
  sheet, at the same link — rewriting every product ID and, when a fresh re-stitched copy is ready,
  every video link; every other cell keeps its value from the template and the catalog's creation.
- **FR-008**: Product IDs after an update MUST be unique within the sheet and MUST NOT repeat any ID
  the sheet has had before. Rule (owner, 2026-09-15): the _k_-th update adds `500 + (k − 1)` to every
  ID — +500 on the first update, +501 on the second, +502 on the third, and so on — so the step
  itself changes and the sequence does not read as a fixed pattern. A 100-product sheet goes
  1…100 → 501…600 → 1002…1101 → 1504…1603. Row order is kept: the row that had the smallest ID
  still does. Because every step is at least 500 and a sheet has at most 400 products, no ID can
  repeat.
- **FR-009**: Overdue updates MUST run once, not once per missed interval; the next due time is then
  one interval after the update that ran.
- **FR-010**: A failed update of one catalog MUST be retried and MUST NOT delay or block the others;
  repeated failure MUST be shown per catalog.
- **FR-011**: Changing the selection, interval or re-stitch option of a running updater MUST take
  effect as described in US4; stopping MUST end all updates and preparation.

**Panel**

- **FR-012**: While an updater runs, the space header MUST show a compact panel beside the space
  settings with: a running indicator, a per-second countdown to the next update, the number of
  catalogs, and — when re-stitching is on — how many have their next copy ready; an attention state
  when any catalog needs it. Clicking the panel MUST open the dialog.
- **FR-013**: The panel and dialog MUST reflect changes made by other members without a reload.

**Re-stitching**

- **FR-014**: With re-stitching on, the system MUST keep, per catalog, at most one spare re-stitched
  copy being prepared or ready, plus the copy currently used by the sheet; any other re-stitched copy
  of that catalog MUST be deleted.
- **FR-015**: A spare copy MUST always be re-stitched from the catalog's original video using the
  space's re-stitch defaults, and MUST be placed next to the original video with a name that
  identifies it as the updater's copy of that video.
- **FR-016**: Preparation MUST start immediately when re-stitching begins for a catalog (updater
  start, catalog added, option switched on) and again right after each update consumes a spare copy.
- **FR-017**: At an update, a ready spare copy MUST be shared by link, its link MUST replace the video
  links in the sheet (distinct per row as in feature 022), and the copy the sheet used before MUST be
  deleted permanently, not moved to the trash.
- **FR-018**: Re-stitching MUST be performed by a member's desktop app chosen when re-stitching is
  switched on ("this computer re-stitches for the updater"), without an open browser tab; the dialog
  and panel MUST show which computer it is and whether it is online.
- **FR-019**: Stopping the updater, removing a catalog, or switching re-stitching off MUST cancel
  preparation and delete spare copies; the sheet keeps its current links.

**Delivery**

- **FR-020**: The registry, the updater, the panel and ID updates MUST work with the server and web
  alone; re-stitching (FR-014–FR-019) MAY require a new desktop app version, and the dialog MUST say
  so when the chosen computer's app is too old.

### Key Entities

- **Catalog** (existing, feature 022): a sheet made from a video. Gains: its update count, last
  update time, current video target (original or a re-stitched copy), and last update error.
- **Updater**: one per space — its catalogs, interval (1 h / 1 d / 1 w), re-stitch on/off, the
  computer that re-stitches, state (running / stopped), next due time, who started or changed it.
- **Re-stitched copy**: a video file next to a catalog's original video, made by the updater for that
  catalog; either "spare" (being prepared or ready) or "in use" (the sheet's links point at it).

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Every catalog in a running updater is updated within 5 minutes of its due time, in 99% of
  updates, with nobody online.
- **SC-002**: After any number of updates, a sheet has never repeated a product ID, and its link has
  never changed.
- **SC-003**: With re-stitching on and the re-stitching computer online, 95% of updates switch to a
  fresh video, because the copy was ready before the due time.
- **SC-004**: At any moment, each catalog has at most two re-stitched copies of its video in Drive (in
  use + spare); after the updater stops, at most one (in use).
- **SC-005**: A member finds a given catalog in the registry within 10 seconds by search.
- **SC-006**: The panel's countdown is never more than 2 seconds off the server's due time.

## Assumptions

- **One updater per space** in this version; a second, independent schedule is out of scope.
- **Intervals** are exactly 1 hour, 1 day, 1 week, counted from the start (or the last change / the
  last update that ran).
- **The sheet keeps its link.** Updates rewrite the existing sheet; they never create a new one,
  because ad platforms are pointed at the link.
- **Without re-stitching, video links do not change** on update; only IDs do.
- **Re-stitching uses the space's re-stitch defaults** (feature 015) and the chosen computer's screen
  image library; per-catalog re-stitch settings are out of scope.
- **Permanent deletion of used copies** is deliberate: they are regenerable, and the owner does not
  want them accumulating (Drive's trash still counts against storage). It applies only to copies the
  updater made.
- **The chosen computer** must stay on and signed in for re-stitching to keep up; the updater never
  waits for it to rewrite IDs.
- **Re-stitched copies do not follow** their video through rename or move (feature 022's tail); the
  next spare copy is made next to the video wherever it is then.
- **Out of scope**: per-catalog intervals, schedules at a chosen time of day, notifications outside
  the app, editing product values other than IDs and video links, re-stitching for catalogs outside
  the updater.
- **Delivery**: registry, updater and ID updates first (server + web); re-stitching with the desktop
  app release. Research notes for planning are in the conversation that produced this spec and will
  be written to `research.md` by `/speckit-plan`.
