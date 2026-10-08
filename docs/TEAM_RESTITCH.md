# Re-stitching from a team space

A member opens a space, picks **Download re-stitched** on a video, and gets the file with this
space's screens on it. The promise is ten seconds. Everything below exists to keep it.

The stitching itself is feature 014's and is documented in [VIDEO_STITCHER.md](VIDEO_STITCHER.md)
— the body is copied, never re-encoded, and only the screens are made. What 015 adds is a
space-wide answer to _which_ screens, and a way to pay the expensive part once.

---

## Where the time goes

Measured on the development machine, a two-minute 1080×1080 source:

| Phase                                    | Prepared   | Not prepared |
| ---------------------------------------- | ---------- | ------------ |
| Transfer of the source (~25 MB)          | 2–5 s      | 2–5 s        |
| Keyframe index + search for old screens  | **0 s**    | 6.7–13.9 s   |
| Silence bank (first run on this machine) | **0 s**    | 10.7–19 s    |
| Body cut and copy                        | 1–2 s      | 1–2 s        |
| Two screens, 300 pictures each           | ~1.4 s     | ~1.4 s       |
| Join, verify, save                       | ~1.5 s     | ~1.5 s       |
| **Total**                                | **6–10 s** | 22–43 s      |

The transfer is the only line this feature does not control, which is why the claim is written
as "does not grow with duration **beyond the transfer of its own bytes**". The local half —
source in hand to finished file — is under five seconds for any length once prepared.

Asserted, not only recorded: `tests/stitch-integration.test.ts` runs a real delivery from a
prepared record against the real engine and requires it under five seconds from source in hand
to finished file. It currently takes **1.9 s** on a 320×320 fixture, with the body's packets
identical to the source's by frame hash and the source file's sha256 unchanged.

The two zeroes are the whole feature. Both are paid by **Prepare material**, once per space,
and both are shared: the member who presses the button is not the only one who benefits,
because what is found is written back to the space.

---

## What a preparation is

One row per material in `team_material_restitch_prep`: where the existing screens were found,
the source profile a cut needs, and the `driveVersion` those answers were computed from.

**It is invalidated by exactly one thing**: the file's bytes changing, which `driveVersion`
already tracks. A mismatch reads as "nothing prepared" rather than as an error, so a replaced
video simply costs its inspection again.

**It is deliberately not keyed to anything a member changes daily** — not the photos, not the
fit mode, not the hold length, not the operation. None of those changes what is _inside_ the
file, which is precisely why changing the space's defaults keeps every preparation valid. If
you ever find yourself adding a settings field to that key, the feature has stopped being worth
its button.

A material that cannot be served at all is a record too: `unsupported_reason` set, no profile.
Storing the refusal is what stops it being re-derived on every download of the same file.

---

## Two traps

### The Soty folder is found by its mark, never by its name

The folder is created by the button and by nothing else — no member is ever asked to create it,
name it or locate it. It carries `appProperties: { "soty.workspace": "<team id>" }`, which Drive
shows to no application but this one.

Resolution order, in `supabase/functions/drive-ops/workspace-folder.ts`: the cached id → a
search for the mark → create. A member may rename it to anything and drag it anywhere; both the
id and the mark survive, so neither costs a call. **Never match it by name.** A second folder
called `Soty` appearing beside the first is the one failure a member would notice and not
understand.

### Findings do not travel on the event channel

`TeamOperationEvents` is a broadcast, and it is content-free on purpose: an operation id, a
stage, a number. A finding names a file and describes its shape, so preparation publishes only
its progress there and keeps the substance behind `GET /api/team/restitch/prepare/:operationId`.
If you ever need to push richer progress, widen that route — not the channel.

---

## Two smaller decisions worth knowing

**Grants are handed over a handful at a time.** A transfer grant lives twenty minutes; fifty
materials take longer than that. `useRestitchPreparation` requests five grants, hands them over,
waits, and only then requests the next five. One extra local round trip per batch buys grants
that are never stale.

**The agent never talks to Supabase.** Preparation and delivery both hand their findings back to
the web, which stores them. The bridge has never had a cloud client and this feature was not the
reason to give it one.

---

## Verified against the running beta

2026-09-02, with the fixture account and no drive connected:

- The section saves through `set_restitch_defaults` — row written as `restitch`, six start and
  six end photos, `cover`, `random-30-40`, `configured`.
- `POST /drive-ops/ensure-workspace-folder` with a real member's JWT answers
  `403 PERMISSION_DENIED` — authenticated, team resolved, refused for want of a connection,
  which is the contract's own code rather than a crash.
- The agent publishes `stitcher: 1` and `teamWorkspace: 2`, so `agentCanRestitch()` is true.
- Its three routes answer `202 {accepted}`, `400 INVALID_INPUT`, `404 NOT_FOUND`. A
  two-material run inspected them **one at a time**, gave each failure its true reason
  (`PERMISSION_DENIED` from the transfer, not a generic error), reached `finished`, and stayed
  readable afterwards.

Not yet measured, because it needs a connected Drive: the folder actually being created, a
real preparation, and a timed re-stitched download.

---

## When something is wrong

- **Every download is slow, even after preparing.** Check that the material's `driveVersion`
  still matches: a sync that rewrote the file invalidates every preparation of it, correctly.
- **A second Soty folder appeared.** The mark was lost — most likely the folder was recreated by
  hand. The button will adopt whichever one carries the mark; delete the other.
- **A material is always "not prepared".** It is probably a refusal: read
  `unsupported_reason` on its row. `video-codec` means the fast path cannot copy that body, and
  no amount of preparing will change it.

## Pictures from the space (030)

Since feature 030 a space's start and end pictures are not copies of anyone's library. The
owner picks **sources** — image files and folders of the connected Drive — into two pools, one
per slot, with the same pickers the tasks and the catalog use. The server resolves a pool into
its effective set at read time (PNG, JPEG, WebP; up to 50 MB; one entry per distinct md5; the
first 500 in name order) and reports every source's availability: in the bin, deleted, outside
the connected folder, unsupported, waiting for the catalog, or disconnected. Saving needs no
running app, and no byte of any picture passes through a server.

For a job the server **draws** one picture per enabled slot (`draw_restitch_screens`, uniform
over distinct bytes) and the browser takes an ordinary download grant on each; the agent
receives the screens with the job and keeps them in its own cache, `TeamScreens/<materialId>-<md5>`,
never in the compressor's library. A picture it already has with the same md5 is not fetched
again; a picture replaced in Drive gets a new key; copies no pool wants age out after thirty
days or past five hundred per space. When the fetch fails but the copy is there, the copy wins.
Phone photographs stand upright: the EXIF orientation is read from the bytes and applied as a
filter with FFmpeg's autorotation off and the display matrix cleared, so the result is the same
on every FFmpeg build.

Background copies for the catalog updater always draw the **space's** pool with the owner's
settings, whoever's tab claims the job; a member's personal pool applies only to their own
interactive downloads. A claim from a page that predates Drive pools is refused before any job
is taken (`RESTITCH_CLIENT_OUTDATED`); an app that predates them is told so by the page. A pool
with nothing to give defers the job for an hour without spending an attempt, and the updater
chip says why.

Spaces saved before 030 keep working the old way (their settings say `legacy`) and see a banner
asking the owner to pick from the space or to move the old pictures into it. Moving reads them
from the bucket, uploads them into `Re-stitch images/<slot>` through the ordinary relay, and adds
that folder to the slot's pool. The bucket's INSERT policy is gone; its objects wait for the
approved list in `supabase/migrations/20261105100000_restitch_bucket_retirement.sql`.
