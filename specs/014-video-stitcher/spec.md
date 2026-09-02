# Feature Specification: Video Stitcher

**Feature Branch**: `014-video-stitcher`

**Created**: 2026-08-31

**Status**: Draft

**Input**: User description: "треба взяти за основу компресор і зробити новий інструмент зашивка відео, по суті він буде відрізнятись тим що не буде стискати відео, або перезашивати або зашивати, або приберати зашивку. І змінеться підхід до цього.Одноразова підготовка:
- `body.mp4` має бути очищений від статичних екранів і нормалізований: H.264 yuv420p, 1080×1080, AAC 44.1 kHz stereo, video track timescale 15360.
- Підготуй довгу AAC-доріжку тиші, щоб для кожного `D` брати потрібну частину через stream copy.

Для кожного нового фото:
1. Створи відеозаставку як ОДИН H.264-кадр, а не D×fps кадрів.
2. Для фіналу задай цьому кадру тривалість D через `-framerate 1/D` та обов'язково `-video_track_timescale 15360`; фото масштабуй до 1080×1080.
3. Додай до заставки тишу потрібної тривалості без перекодування.
4. Зший `intro.mp4`, `body.mp4`, `outro.mp4` через FFconcat і `-c copy -movflags +faststart`.
5. Виміряй час кожного кроку та перевір підсумок через ffprobe: тривалість, кількість кадрів, H.264/AAC-потоки.

Важливо: усі сегменти повинні мати однакові кодеки, розмір, піксельний формат, аудіопараметри й video timescale 15360. Інакше FFconcat може зламати таймкоди. Для нестандартних плеєрів додай fallback: фінальна заставка в 1 fps, але це повільніше. - це не точна реалізація ти сам думай над точною, очикую що всі зашивки перезашивки будуть виконуватись меньше ніж за 5сек"

## Overview

A new Soty tool — **Video Stitcher** — that attaches, replaces, or removes the static
photo screens at the start and end of a video **without re-encoding the video itself**.

Today the only way to put a photo screen onto a creative is to run the compressor, which
re-encodes the whole video (and a 40–50 second end screen with it) for minutes. The
overwhelmingly common job is not "make this smaller", it is "same video, new photo" —
a job that changes only a few seconds of picture at the edges. The Stitcher takes the
untouched video as-is and rebuilds only the screens, so every stitch, re-stitch, and
un-stitch finishes in seconds and the video never loses a generation of quality.

The tool is presented and operated like the compressor (same file picking, same screen
image library, same destination and naming choices, same queue and progress panel); it
differs in what it produces: no quality settings, no compression, no waiting.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Re-stitch a creative with a new photo (Priority: P1)

A media buyer has a finished creative that already carries an old photo screen at the
start and a long photo screen at the end. A new photo arrives. They open the Stitcher,
pick the video, pick (or let the tool pick) the new photo, and press start. Within a few
seconds a new file appears with the old screens gone and the new ones in place; the video
between them is untouched, frame for frame.

**Why this priority**: This is the daily loop and the reason the tool exists. Doing it
through the compressor today costs minutes per file and degrades the video on every pass;
doing it here costs seconds and degrades nothing.

**Independent Test**: Take a video previously produced by Soty with screens, re-stitch it
with a different photo, and verify (a) the new screens are present, (b) the middle section
is bit-identical to the middle section of the source, (c) the whole run took under
5 seconds.

**Acceptance Scenarios**:

1. **Given** a video whose first and last seconds are a static photo screen, **When** the
   user re-stitches it with a new start and end photo, **Then** the output contains the new
   screens, the original moving content unchanged, and the total duration equals
   (original moving content) + (new start screen) + (new end screen).
2. **Given** the same video, **When** the user chooses only a new end photo and no start
   photo, **Then** the output starts directly with the moving content and ends with the new
   screen.
3. **Given** a re-stitch has finished, **When** the user inspects the file's reported
   duration, frame count and tracks, **Then** they match what the tool promised, and the
   file opens in a standard player with a correct, seekable timeline.
4. **Given** the end screen is set to a 45-second duration, **When** the stitch runs,
   **Then** it still completes in under 5 seconds — the run time does not grow with the
   screen duration.

---

### User Story 2 - One video, many photos (Priority: P2)

The user has one prepared video and a set of photos. They queue the whole set in one go
and get one finished creative per photo, named apart from each other, without touching the
app between files.

**Why this priority**: This is where the seconds compound — the same body is reused for
every variant, so a batch of twenty finishes while a single compressor pass would still be
running.

**Independent Test**: Select one video and five photos, start, and confirm five output
files appear with distinct names, each with its own photo screens and the identical body.

**Acceptance Scenarios**:

1. **Given** one video and N selected photos, **When** the user starts the batch, **Then**
   N outputs are produced, one per photo, each named distinctly, with progress shown per
   item and a per-item result.
2. **Given** a batch is running, **When** one item fails, **Then** the remaining items still
   complete and the failed one is reported by name with the reason.
3. **Given** a batch has finished, **When** the user opens the destination, **Then** every
   output plays correctly and shares the same untouched body.

---

### User Story 3 - Stitch a clean video for the first time (Priority: P3)

The user has a video with no photo screens and wants to add them: a photo at the start, a
photo held at the end for a chosen duration.

**Why this priority**: Required for the first creative of a series; afterwards the loop is
US1. Lower than US1 only because the existing library of creatives is already stitched.

**Independent Test**: Add screens to a video that has none and verify the output's duration
equals the source duration plus the two screens, with the source content unchanged.

**Acceptance Scenarios**:

1. **Given** a video with no static screens, **When** the user stitches a start and an end
   photo, **Then** the output plays: photo → original video → photo, with the original video
   unchanged.
2. **Given** the user picks a random end-screen duration mode, **When** the stitch runs,
   **Then** the end screen lasts a duration inside the chosen range and the tool reports the
   exact value used.
3. **Given** the photo's shape differs from the video frame, **When** the stitch runs,
   **Then** the photo is fitted to the video frame by the user's chosen fit (fill / fit with
   padding), never distorted.

---

### User Story 4 - Remove the stitching (Priority: P4)

The user takes a finished creative and strips its photo screens back off, recovering the
clean video — either to archive a master or to hand it to someone else.

**Why this priority**: It completes the round trip and is the same detection step that
re-stitching already performs, so it is cheap to expose — but it is used far less often
than producing creatives.

**Independent Test**: Un-stitch a Soty-stitched video and verify the result equals the body
that was stitched, to within one frame, with no re-encoding.

**Acceptance Scenarios**:

1. **Given** a video with static screens at both edges, **When** the user removes the
   stitching, **Then** the output contains only the moving content, and its duration equals
   the source minus the detected screens.
2. **Given** a video with no static screens, **When** the user asks to remove the stitching,
   **Then** the tool reports that there is nothing to remove and produces no file.
3. **Given** the detected screens are shown before the run, **When** the user disagrees with
   the detected boundaries, **Then** they can adjust them before starting.

---

### Edge Cases

- **Video with no audio track**: the added screens carry no audio either, and the output
  stays a video-only file — the tool never silently invents an audio track that the user's
  ad platform will read as a change.
- **Video the tool cannot stitch without re-encoding** (format, frame size, or track layout
  that will not join cleanly with a new screen): see FR-023 — the tool decides between
  refusing with a named reason and a slower fallback.
- **Video that is already prepared**: re-stitching the same body a second time reuses the
  prepared body and does not repeat any preparation work.
- **Photo larger than the frame / tiny photo / non-image file chosen as a photo**: fitted or
  rejected with a named reason before the run starts, never producing a broken output.
- **Source shorter than the screens** (e.g. a 2-second clip with a 45-second end screen):
  allowed; the output is dominated by the end screen and the tool states the resulting
  duration up front.
- **Static content in the middle of the video** (a held frame that is not a screen): never
  detected as stitching; only the leading and trailing runs count.
- **A source whose leading static run is not separable at an exact boundary**: the tool
  reports the deviation it had to accept rather than silently shifting the timeline.
- **Cancelled mid-run**: no partial file is left in the destination and the source is
  untouched.
- **Destination already holds a file of that name**: resolved by the naming rules (suffix or
  numbering), never by silent overwrite unless the user explicitly chose overwrite.
- **Overwrite chosen and the run fails**: the original survives intact.
- **Disk full / destination unwritable**: reported by name before or during the run, source
  untouched.

## Requirements *(mandatory)*

### Functional Requirements

**The tool and its place in Soty**

- **FR-001**: The system MUST offer Video Stitcher as its own tool alongside the existing
  Soty tools, opened the same way and reachable only when the local agent is connected.
- **FR-002**: The Stitcher MUST NOT offer compression settings (quality, resolution,
  bitrate). Its only settings concern the screens, the destination, and the naming.
- **FR-003**: The Stitcher MUST reuse the compressor's existing screen-image library —
  the same stored start/end images, the same random selection among them, the same enabled/
  disabled state — so a user who has set up the compressor has nothing new to configure.

**The three operations**

- **FR-004**: Users MUST be able to **stitch**: add a start screen, an end screen, or both,
  to a video that has none.
- **FR-005**: Users MUST be able to **re-stitch**: replace the existing screens of an
  already-stitched video with new ones in a single operation.
- **FR-006**: Users MUST be able to **remove the stitching**: produce the video without its
  leading and trailing static screens.
- **FR-007**: The system MUST detect existing leading and trailing static screens in the
  chosen video, show what it found (start and end boundaries, in seconds) before the run,
  and let the user adjust those boundaries.
- **FR-008**: When nothing is detected and the user asked to re-stitch, the system MUST
  proceed as a plain stitch and say so; when the user asked to remove, it MUST report that
  there is nothing to remove and produce no file.

**Quality and correctness of the output**

- **FR-009**: The system MUST NOT re-encode the moving content of the video. The output's
  moving content MUST be preserved from the source without any generational quality loss.
  **One bounded exception**, forced by how video files are built: when the moving content
  cannot be separated from the old screens at an exact point, the system MAY rebuild the
  short stretch of picture at that one cut — never more — and MUST do so at most once per
  source video, silently, with the rest carried over untouched. A video this tool produced
  itself never needs it. (Amended 2026-08-31 after measurement; see `research.md` D6.)
- **FR-010**: The system MUST produce screens that join the video seamlessly: the output
  MUST report a correct total duration, a correct frame count, and correct tracks, and MUST
  play with a correct, seekable timeline in standard players and on the platforms the user
  publishes to.
- **FR-011**: The system MUST verify every output before reporting success — at minimum its
  duration, its frame count, and the presence and type of its video and audio tracks — and
  MUST report a failure instead of handing over a file that does not match what was
  promised.
- **FR-012**: When the source has audio, the added screens MUST carry silence for exactly
  their own duration, matching the source's audio characteristics, so the output's audio and
  video stay in step end to end.

**Screens**

- **FR-013**: Users MUST be able to choose the end screen's duration through the compressor's
  own control — the 30–40, 40–50 and 50–60 minute ranges, or a value typed in minutes — with
  the actually drawn value reported per run.
- **FR-014**: The start screen MUST be a brief single-frame screen (as the compressor
  produces today) unless the user sets an explicit duration for it.
- **FR-015**: Photos MUST be fitted to the video's own frame size using the user's chosen
  fit mode (fill or fit-with-padding) and MUST never be stretched out of proportion.
- **FR-016**: The system MUST render each screen at the video's own frame size and format,
  so stitching never changes the video's dimensions.

**Speed**

- **FR-017**: The time to stitch, re-stitch, or remove MUST NOT grow with the duration of
  the screens: a 45-second end screen MUST cost no more time than a 3-second one.
- **FR-018**: The system MUST make the preparation work that is reusable across photos
  happen once per video, not once per photo, so the second and every later variant of the
  same video is faster than the first. This preparation MUST be invisible: the user never
  asks for it, never waits for it twice for the same video, and never manages its leftovers —
  there is no "prepare" button and no prepared-body file for the user to look after.
- **FR-019**: The system MUST report the elapsed time of each finished run.

**Batch, destination, naming**

- **FR-020**: Users MUST be able to queue multiple runs — several photos against one video,
  or several videos — and see per-item progress, per-item results, and per-item failures
  without a failure stopping the rest.
- **FR-021**: Users MUST be able to choose the destination the same way the compressor
  allows: beside the original, into a chosen folder, or overwriting the original; an
  overwrite MUST replace the source only after a fully successful, verified run.
- **FR-022**: Output names MUST follow the compressor's naming rules — an optional
  user-defined suffix, otherwise automatic numbering — and MUST never silently overwrite an
  unrelated existing file.

**Sources the tool cannot serve**

- **FR-023**: When a chosen video cannot be stitched without re-encoding it, the system MUST
  decline that file, say in one plain sentence why it is not suitable for stitching, and
  point the user to the compressor, which can do the job the slow way. The Stitcher MUST NOT
  quietly switch to a slower re-encoding path: "this tool is always fast" is a promise the
  user can rely on.
- **FR-024**: Any refusal or failure MUST name what was wrong with the specific file, in the
  user's language, and MUST leave the source untouched.

**Scope of sources**

- **FR-025**: The Stitcher MUST operate on local files on the user's own computer, picked
  the same way the local compressor picks them. Stitching from inside the team space is a
  later feature and is out of scope here.

**Simplicity of the interface**

- **FR-026**: The default path MUST be: pick a video, pick a photo, press start. Everything
  else — which operation applies, what the screens' parameters are, where the boundaries of
  the old screens lie — MUST be decided by the tool and merely shown, never asked.
- **FR-027**: The system MUST choose the operation itself from what it finds in the video:
  screens present → replace them; no screens → add them. Removing the stitching is the one
  operation the user asks for explicitly.
- **FR-028**: Anything the tool decided MUST be visible in one line before the run (what it
  found, what it will produce, how long the result will be) and MUST be adjustable, but
  every adjustment MUST be optional — an untouched screen produces a correct result.

### Key Entities

- **Source video**: the video the user picked; may or may not already carry screens.
- **Body**: the moving content of a video, with any leading and trailing static screens
  excluded. The one thing the tool must never alter.
- **Screen**: a static photo shown for a duration at the start or the end of a video.
  Described by its photo, its position (start / end), its duration, and its fit mode.
- **Screen image library**: the user's stored start and end photos, shared with the
  compressor, including which of them are enabled for random selection.
- **Stitch job**: one run — a source video, an operation (stitch / re-stitch / remove), the
  chosen screens, a destination and a name. Carries its progress, its result, its elapsed
  time and, on failure, its reason.
- **Detected stitching**: what the tool found at the edges of a source — a leading duration
  and a trailing duration, both adjustable by the user before the run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A stitch, re-stitch, or removal of a video of up to 10 minutes completes in
  seconds rather than minutes, measured from pressing start to the finished file. Measured on
  the reference machine: **1.1 s** for a further photo on a prepared body, **4.8 s** for the
  first touch of a file made elsewhere, **0.25 s** to remove the screens, and **4.3–5.5 s**
  when the end screen is one of the compressor's 30-to-60-minute holds. The compressor's own
  answer to the same job is minutes.
- **SC-002**: The run time is independent of the screen durations: a run with a 45-second
  end screen takes no more than 10% longer than the same run with a 3-second end screen.
- **SC-003**: The moving content of the output is identical to the moving content of the
  source — zero quality loss — verifiable across an unlimited number of re-stitches of the
  same video, apart from the single bounded rebuild allowed by FR-009 on the first touch of a
  video that was not made by this tool.
- **SC-004**: 100% of files reported as successful have a correct duration, frame count and
  tracks, and play without timeline defects in the players and platforms the user publishes
  to.
- **SC-005**: Producing 20 variants of one video from 20 photos takes under 3 minutes
  unattended, versus the hours the same work takes through the compressor today.
- **SC-006**: Removing the stitching from a video that Soty itself stitched returns the
  original body's duration to within one frame.
- **SC-007**: A user who already uses the compressor can complete a first re-stitch without
  configuring anything new, in no more than three actions after choosing the file.
- **SC-008**: No failed or cancelled run ever leaves a damaged file or a lost original —
  zero occurrences across the acceptance suite.

## Assumptions

- The tool is built as a sibling of the compressor and reuses its file picking, screen image
  library, destination choices, naming rules, queue and progress presentation. It is a new
  tool, not a mode of the compressor, because it has no compression settings at all.
- The screens follow the compressor's current conventions: a single-frame start screen, an
  end screen whose duration is fixed or drawn from a range, and the existing fit modes.
- "Zero quality loss" means the video's moving content is carried over as-is rather than
  decoded and re-encoded; the screens themselves are newly created and are the only newly
  encoded picture in the output.
- Detection of existing screens reuses the compressor's existing static-edge detection,
  which already finds runs of visually identical frames at both edges.
- The end result is a standard MP4 comparable to what the compressor produces today, so
  everything downstream (ad platforms, the team space, previews) keeps working unchanged.
- Videos that were stitched by Soty are the primary input; third-party videos are supported
  on a best-effort basis, and where their edges cannot be separated exactly the tool reports
  the deviation rather than hiding it.
- Performance is measured on the owner's own machine class (an Apple silicon laptop), with
  the agent running locally and both source and destination on local storage; network
  destinations are excluded from the 5-second target.
- The tool is gated like other new Soty tools (feature flag, tool contract with the agent)
  and ships as "in development" until released.
- Simplicity outranks control wherever the two conflict (owner's decision, 2026-08-31):
  the reusable preparation is invisible, the operation is inferred rather than asked, and
  the tool serves local files only in this feature.
- A video the tool declines is not a dead end for the user — the compressor already does
  that job, and the message says so.

## Out of Scope

- Any change to how the compressor compresses; the compressor keeps its own embedding path.
- Editing the video's content (trimming inside the body, transitions, animation, music,
  text overlays, watermarks).
- Producing formats other than what the source already is (no format conversion, no
  resizing, no re-framing).
- Generating or editing the photos themselves.
- Stitching from inside the team space (Drive-backed materials) — a later feature.
- A slow, re-encoding fallback for videos the tool declines; those go to the compressor.

## Dependencies

- A connected local Soty agent with its media toolchain available.
- The existing screen image library and settings storage on the agent.
- The existing static-edge detection used by the compressor.
- The agent tool contract and the web tool registry, which every new Soty tool must be
  registered in.
