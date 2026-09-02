# Re-stitching from a team space

A member opens a space, picks **Download re-stitched** on a video, and gets the file with this
space's screens on it. The promise is ten seconds. Everything below exists to keep it.

The stitching itself is feature 014's and is documented in [VIDEO_STITCHER.md](VIDEO_STITCHER.md)
— the body is copied, never re-encoded, and only the screens are made. What 015 adds is a
space-wide answer to *which* screens, and a way to pay the expensive part once.

---

## Where the time goes

Measured on the development machine, a two-minute 1080×1080 source:

| Phase                                     | Prepared   | Not prepared |
| ----------------------------------------- | ---------- | ------------ |
| Transfer of the source (~25 MB)           | 2–5 s      | 2–5 s        |
| Keyframe index + search for old screens   | **0 s**    | 6.7–13.9 s   |
| Silence bank (first run on this machine)  | **0 s**    | 10.7–19 s    |
| Body cut and copy                         | 1–2 s      | 1–2 s        |
| Two screens, 300 pictures each            | ~1.4 s     | ~1.4 s       |
| Join, verify, save                        | ~1.5 s     | ~1.5 s       |
| **Total**                                 | **6–10 s** | 22–43 s      |

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
fit mode, not the hold length, not the operation. None of those changes what is *inside* the
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
