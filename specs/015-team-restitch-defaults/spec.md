# Feature Specification: Re-stitch defaults and prepared materials in the team space

**Feature Branch**: `011-team-workspace-rework`
**Created**: 2026-09-02
**Status**: Draft
**Input**: Owner brief — a simple place in the team space to set the defaults for re-stitching,
a button that prepares working material on the connected drive, and a per-material "download
re-stitched" that finishes in under ten seconds.

## Why this exists

Re-stitching a creative in the team space today means: open the row menu, choose Process, pick
a tool, fill a dialog, wait for an operation, then find the result and download it. The owner
re-stitches the same library of materials over and over with the same photos and the same
lengths. Everything in that dialog is the same every time.

This feature makes the settings a property of the **space**, set once, and turns the whole act
into one button on the material: **Download → re-stitched**.

### Is preparing material in advance worth it? — Yes, and here is the measurement

The owner asked to be told plainly if preparation would not speed anything up. It does, and by
a large margin, because most of a re-stitch is not the stitching.

A re-stitch measured end to end on this machine (Apple M1, local agent, verified this week):

| Step                                        | 50-second source | 52-minute source |
| ------------------------------------------- | ---------------- | ---------------- |
| Read the file's keyframe index              | 0.2 s            | **5.0 s**        |
| Find the screens already on it              | 6.5 s            | **8.9 s**        |
| Cut and copy the body                       | 1–2 s            | 1–2 s            |
| Build the two screens                       | ~1.4 s           | ~1.4 s           |
| …plus the silence bank, the first time ever | **10.7–19 s**    | **10.7–19 s**    |
| Join and verify                             | ~1 s             | ~1 s             |
| **Total observed**                          | **4.6–11.9 s**   | **17.8 s**       |

Two of those lines dominate, and **both depend only on the file's own bytes** — not on which
photo is chosen, not on how long the screen is held, not on any setting the user may change
later. They can therefore be computed once per material and reused for every future re-stitch:

- **Inspection** (keyframe index + screen detection): 6.7 s to 13.9 s per material, gone.
- **The silence bank**: 10.7–19 s, once per space, gone.
- **The source transfer** from the drive to the machine doing the work: proportional to the
  file, and the one part that can make ten seconds impossible on a slow connection.

What preparation does **not** meaningfully help:

- **The screens themselves** (~1.4 s). Their content depends on the chosen photo, the fit mode,
  the frame size and a randomly drawn hold length, so a prepared screen only helps if the draw
  is made in advance too. It is included as a second-order optimisation, clearly marked, and
  the feature is worth building without it.
- **The join and the verification** (~1 s). Nothing to precompute.

So: prepare the inspection, the silence, and the body. Do not try to prepare the whole answer.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Set the defaults once (Priority: P1)

A space owner opens the space's settings, finds a **Re-stitching** section, and sets exactly
what the stitcher tool already asks for: what to do (re-stitch / stitch / remove), which photos
may be drawn for the opening and closing screens, how the photo fills the frame, and how long
the closing screen is held. They save. Every later re-stitch in this space uses these.

**Why this priority**: nothing else in the feature can exist without a saved default. It is
also the whole of the "no wheel reinvented" instruction — the panel is the stitcher's own
controls, in the space's settings.

**Independent Test**: open the settings of a space with no defaults, set them, reload, and see
them still set. No material has to be touched.

**Acceptance Scenarios**:

1. **Given** a space with no re-stitching defaults, **When** the owner opens the space settings,
   **Then** a Re-stitching section is shown, marked as not yet configured.
2. **Given** the section is open, **When** the owner chooses photos, a fit mode, an operation
   and a hold length and saves, **Then** the section reports the space as configured and shows a
   one-line summary of what was chosen.
3. **Given** defaults exist, **When** a second member with permission opens the settings,
   **Then** they see the same defaults, and their changes are seen by everyone.
4. **Given** a member without permission to change the space, **When** they open the settings,
   **Then** the section is readable and not editable.

---

### User Story 2 - Download a material already re-stitched (Priority: P1)

On any video in the space, the download action offers a choice: **the original**, or
**re-stitched**. Choosing re-stitched shows progress in place, and the finished file is handed
to the browser as a download the moment it is ready.

**Why this priority**: this is the act the whole feature exists for. It is testable the moment
User Story 1 exists, with or without preparation — preparation only changes how long it takes.

**Independent Test**: with defaults set and no material prepared, download a video re-stitched
and confirm the file that arrives carries new screens and the original's body.

**Acceptance Scenarios**:

1. **Given** defaults are set, **When** the member picks Download → re-stitched on a video,
   **Then** progress is shown on that row and the finished file is offered as a download
   without any further click.
2. **Given** the same, **When** the run finishes, **Then** the delivered file's moving part is
   the source's own, and its screens are the ones the defaults describe.
3. **Given** a video the tool cannot serve (not H.264, variable frame rate, and so on),
   **When** re-stitched is chosen, **Then** the member is told which property makes it
   unsuitable and is offered the original instead.
4. **Given** a run is under way, **When** the member leaves the folder or the page, **Then**
   the run is abandoned cleanly and nothing partial is left in the space.
5. **Given** the same video is asked for twice, **When** the second request is made, **Then**
   the second delivery does not repeat the work that does not depend on the photo.

---

### User Story 3 - Being told the defaults are missing, and fixing it without leaving (Priority: P1)

A member picks Download → re-stitched in a space where nobody has set the defaults. A message
says re-stitching is not configured and offers **Configure now**. The settings open over the
current view; on save, the download proceeds.

**Why this priority**: without it the first use of the feature is a dead end, and the owner
asked for it explicitly.

**Independent Test**: in a space with no defaults, pick Download → re-stitched and complete the
whole path to a delivered file without navigating away.

**Acceptance Scenarios**:

1. **Given** a space with no defaults, **When** re-stitched is chosen, **Then** a message says
   re-stitching is not configured and carries a Configure now action.
2. **Given** that message, **When** Configure now is used, **Then** the same settings as User
   Story 1 open in place, over the current view.
3. **Given** the settings were completed from that message, **When** they are saved, **Then**
   the download that was asked for continues by itself.
4. **Given** a member without permission to change the space, **When** they meet the message,
   **Then** they are told who can set it up rather than being offered a control they cannot use.

---

### User Story 4 - Prepare the material once, so every later download is quick (Priority: P2)

In the same settings section there is **Prepare material**. Pressing it creates a Soty folder on
the space's connected drive and works through the space's videos, doing everything that does not
depend on the chosen photo: reading each file once, finding what is already stitched onto it,
and building the shared silence. Progress is shown per material and the section ends in a plain
statement of how many materials are ready.

**Why this priority**: it is what makes ten seconds reliable rather than lucky, but the feature
works without it — every download simply does the reading itself.

**Independent Test**: prepare a space, then time a re-stitched download of a long video against
the same download in an unprepared space.

**Acceptance Scenarios**:

1. **Given** a connected drive, **When** Prepare material is pressed the first time, **Then** a
   Soty folder is created at the root of the connected drive and is recognised by the space
   afterwards even if a member renames or moves it.
2. **Given** preparation is running, **Then** progress shows which material is being worked on
   and how many remain, and it can be stopped.
3. **Given** preparation finished, **Then** each prepared material is marked as ready in the
   space, and a material added later is shown as not yet prepared.
4. **Given** a material's content is replaced, **Then** its preparation is discarded and the
   material returns to not prepared.
5. **Given** a member changes the default photos or hold length, **Then** the preparation stays
   valid — nothing prepared depends on those.
6. **Given** preparation was never run, **When** a re-stitched download is asked for, **Then**
   it still works, and the material it needed becomes prepared as a side effect.

---

### Edge Cases

- **No drive connected.** Prepare material explains that a drive must be connected first and
  offers the existing connect flow. Re-stitched downloads still work without a prepared folder.
- **The Soty folder was deleted.** The next preparation recreates it; nothing else breaks.
- **The Soty folder was renamed or moved.** It is still found, because it is recognised by a
  marker the space put on it, not by its name or its place.
- **No photos chosen, or every chosen photo disabled.** Saving the defaults is refused with the
  reason, and any download that needs them reports the same reason.
- **The material is not a video** (a document, a landing, a folder). The re-stitched choice is
  not offered on it at all.
- **Two members ask for the same material at once.** Both get their file; the work that does not
  depend on the photo is done once.
- **The space's storage runs out** while preparing. Preparation stops with the reason, keeps
  whatever it finished, and can be resumed.
- **The member's browser blocks the automatic download.** The finished file stays available from
  the row for a while, with a plain "save it" action, rather than being lost.
- **A very long source** (an hour or more). The promise is stated against a prepared material;
  an unprepared one is allowed to take longer and says so while it runs.

## Requirements _(mandatory)_

### Functional Requirements

**Defaults**

- **FR-001**: A space MUST hold one set of re-stitching defaults, shared by every member.
- **FR-002**: The defaults MUST offer exactly the choices the stitcher tool already offers —
  the operation, the opening and closing photo pools, how a photo fills the frame, and the hold
  length of the closing screen — and MUST NOT introduce a second vocabulary for them.
- **FR-003**: The defaults MUST be editable only by members permitted to change the space, and
  readable by all members.
- **FR-004**: The space MUST be able to state whether its defaults are configured, and show a
  one-line summary of them without opening the editor.
- **FR-005**: Saving MUST be refused, with a reason, when the chosen settings could not produce
  a file — no usable photo for a screen the operation requires.
- **FR-006**: Changing the defaults MUST NOT invalidate prepared material.

**Downloading**

- **FR-007**: Every video material MUST offer a download choice between the original and the
  re-stitched result. Non-video materials MUST NOT offer the second.
- **FR-008**: Choosing re-stitched MUST show progress against that material and MUST deliver
  the finished file to the member as a download without a further click.
- **FR-009**: The delivered file MUST carry the source's own moving part unchanged, and the
  screens described by the space's defaults.
- **FR-010**: A material the tool cannot serve MUST be reported with the specific property that
  makes it unsuitable, and the original MUST remain downloadable.
- **FR-011**: Choosing re-stitched with no defaults set MUST produce a message saying so, with
  an action that opens the defaults over the current view; saving there MUST resume the
  download that was asked for.
- **FR-012**: A member who cannot change the space MUST be told who can, rather than offered
  the configure action.
- **FR-013**: Leaving the view or cancelling MUST abandon the run without leaving partial files
  in the space or on the drive.
- **FR-014**: The delivered file MUST be named so that it cannot be mistaken for the original.
- **FR-015**: A finished result MUST remain retrievable from the row for the rest of the
  session, so a blocked or missed download is not lost work.

**Preparation**

- **FR-016**: The defaults section MUST offer Prepare material, which creates — once, by
  itself — a Soty folder on the space's connected drive. No member is ever asked to create,
  name or locate it.
- **FR-017**: That folder MUST be recognised by a marker the space owns, so renaming or moving
  it does not orphan it, and it MUST be usable for other kinds of prepared material later.
- **FR-018**: Preparation MUST compute, per video material, everything that depends only on the
  file's own content: how it is laid out for cutting, and what screens are already on it.
- **FR-019**: Preparation MUST build the shared silence once per space rather than per run.
- **FR-020**: Preparation MUST show progress per material, a count of what remains, and MUST be
  stoppable, keeping whatever it has already finished.
- **FR-021**: The space MUST show, per material, whether it is prepared.
- **FR-022**: Replacing a material's content MUST discard its preparation.
- **FR-023**: A re-stitched download of an unprepared material MUST still work, and MUST leave
  that material prepared afterwards.
- **FR-024**: Preparation MUST NOT modify or move the members' own files.

### Key Entities

- **Space re-stitching defaults** — one per space: the operation, the two photo pools, the fit
  mode, the hold length, and who last changed them.
- **Prepared material record** — one per video material: what was found on it, how it is laid
  out, when it was prepared, and which version of the material it describes.
- **Space working folder** — the Soty folder on the connected drive, identified by a marker
  rather than by name, holding shared prepared material and open to other uses later.
- **Re-stitch delivery** — a running or finished request for one material by one member: its
  progress, its outcome, and the file it produced.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: With the space prepared, a member receives a re-stitched download of a
  two-minute creative **within 10 seconds** of asking for it.
- **SC-002**: With the space prepared, the same holds for a source of any length the space
  holds — the time does not grow with the material's duration by more than the transfer of its
  own bytes.
- **SC-003**: Re-stitching a material a second time takes no longer than the first.
- **SC-004**: Setting up a space from nothing — opening the settings, choosing photos, saving —
  takes **under a minute** and needs no page other than the space.
- **SC-005**: A member who has never configured the space reaches a delivered file **without
  leaving the view they started in**.
- **SC-006**: Preparing a space of 50 videos completes without attention and reports, at the
  end, exactly how many are ready and how many could not be.
- **SC-007**: 100% of delivered files keep the source's moving part unchanged, verified by
  comparison rather than by inspection.
- **SC-008**: No delivered or prepared artefact ever replaces or alters a member's own file.

## Assumptions

- **The tool is the one already built.** Re-stitching means feature 014's behaviour: the body is
  copied, never re-encoded, and only the screens are made. Nothing here changes what a
  re-stitch is.
- **The settings are the stitcher's settings.** The panel is the same set of controls the local
  tool shows, mounted in the space's settings — the owner's "no wheel reinvented".
- **Photos live where they already live.** The screen images are the compressor's own library,
  which the agent already keeps; the defaults record which of them may be drawn.
- **Work happens on a paired agent**, as every other team processing already does. A member with
  no agent paired is told so and offered the original.
- **The prepared body stays local to the machine that will use it.** It is as large as the video
  itself, so putting it on the drive would cost more in transfer than it saves in work. What the
  drive's Soty folder holds is the small, shared material: the silence, the record of what was
  found in each file, and whatever later features put there.
- **The ten-second promise is stated for a prepared space.** An unprepared material is allowed
  to take the time the measurements above show, and says so while it runs.
- **Hold lengths stay random per run** unless the space fixes one. A pre-built screen is
  therefore not assumed; it is a possible later refinement worth about 1.4 seconds.
- **One set of defaults per space**, not per member and not per folder. Per-folder overrides are
  out of scope.

## Out of scope

- Re-stitching several materials at once from the space, or a scheduled/automatic re-stitch.
- Editing the detected boundaries by hand from the team space.
- Putting prepared bodies on the drive, or sharing them between members' machines.
- Any change to what a re-stitch produces, or to the local stitcher tool's own interface.
