# Quickstart — proving the feature by hand

Everything here runs against the beta environment, because that is where a real space, a real
drive and a real agent exist together.

## Prerequisites

```sh
npm run build -w @video-compressor/shared
npm run beta:doctor            # asserts the environment before anything is started
npm run beta:up                # web on 127.0.0.1:5175, agent on 127.0.0.1:43140
```

A space with a connected drive, at least three videos in it (one short, one over ten minutes),
and a paired agent with at least two images in the compressor's library.

---

## 1. The defaults exist and are shared (User Story 1)

1. Open the space → settings → **Re-stitching**. It reads _not configured_.
2. Choose the operation, one or more photos for each screen, a fit mode and a hold range. Save.
3. The section now shows a one-line summary and _configured_.
4. Reload the page. Still configured, same values.
5. Sign in as a second member with `manage_metadata`. Same values.
6. Sign in as a member without it. The section is readable, the controls are not.

**Expected**: `get_restitch_defaults` returns one row per space, not per member.

---

## 2. The empty-state path (User Story 3)

Do this in a space where the defaults were never set.

1. On a video, **Download → re-stitched**.
2. A toast says re-stitching is not set up and offers **Configure now**.
3. Press it — the settings open _over_ the explorer, not on another page.
4. Fill and save.
5. **Expected**: the download that was asked for continues by itself, with no second click.

Then repeat as a member who cannot change the space: the toast must name who can, and must not
offer the action.

---

## 3. A re-stitched delivery, unprepared (User Story 2)

1. In a configured space, pick **Download → re-stitched** on the short video.
2. Watch the row: `transferring → inspecting → stitching → saving`.
3. **Expected**: the file lands in the space's download folder and is revealed. No folder
   dialog appears after the first time.
4. Verify what arrived:

```sh
ffprobe -v error -show_entries format=duration -of csv=p=0 "<the file>"
ffprobe -v error -select_streams v:0 -count_packets \
  -show_entries stream=duration,nb_read_packets -of csv=p=0 "<the file>"
ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "<the file>"
```

**Expected**: video and audio durations agree to within a frame, and the packet count is the
source's body plus the screens — the body was copied, not re-encoded.

---

## 4. Preparation, and what it buys (User Story 4)

1. Settings → **Prepare material**.
2. **Expected**: a folder named `Soty` appears at the root of the connected drive, progress
   names each material with a running count, and the run can be stopped.
3. Rename that folder to something else in the drive's own interface, and move it into another
   folder.
4. Press **Prepare material** again. **Expected**: no second folder is created — the same one
   is found by its marker.
5. Now time the same delivery as section 3, on the **long** video, before and after:

```sh
# read the elapsed time the agent reports for each delivery
```

**Expected**: unprepared, the long video spends 6–14 s before any frame is written; prepared,
that step is absent. The local half of the work — source in hand to finished file — is under
five seconds for either length (research D10).

6. Change the default photos and the hold range, then deliver again. **Expected**: still
   prepared; nothing was invalidated (FR-006).
7. Upload a replacement for one material's content. **Expected**: that material shows as not
   prepared again (FR-022).

---

## 5. The refusals

| Do this                                         | Expect                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| Ask for a re-stitch of an HEVC or VFR video     | the specific property named, the original still offered |
| Ask on a document, a landing, a folder          | no re-stitched choice at all                            |
| Save defaults with no photo for a needed screen | refused with the reason, nothing stored                 |
| Press Prepare with no drive connected           | told to connect first, with the existing connect flow   |
| Cancel a delivery mid-run                       | nothing partial in the space, on the drive, or on disk  |
| Cancel a preparation mid-run                    | what finished stays prepared                            |

---

## 6. The automated half

```sh
npx vitest run tests/team-restitch-*.test.ts tests/stitch-*.test.ts \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

and the SQL side:

```sh
supabase test db
```

The database tests are where the RLS shape is proved: a member of another space must not read
either table, and a member without `manage_metadata` must not write the defaults.
