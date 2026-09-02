# Phase 0 — Research: re-stitch defaults and prepared materials

Everything below is decided. Where a number appears it was measured on this machine
(Apple M1, 8 cores, local agent) during the work on feature 014, not estimated.

---

## D1 — Is preparing material in advance worth building at all?

**Decision**: Yes, and it is the difference between "usually fast" and the ten-second promise.
Prepare **the inspection** and **the shared silence**. Do not prepare the screens.

**Rationale**: a re-stitch decomposes as follows, measured end to end.

| Step                       | 50 s source | 52 min source | Depends on             |
| -------------------------- | ----------- | ------------- | ---------------------- |
| Keyframe index (`ffprobe`) | 0.2 s       | **5.0 s**     | the file's bytes       |
| Screen detection           | 6.5 s       | **8.9 s**     | the file's bytes       |
| Body cut/copy              | 1–2 s       | 1–2 s         | the file + the cut     |
| Two screens                | ~1.4 s      | ~1.4 s        | photo, fit, size, hold |
| Silence bank (first ever)  | 10.7–19 s   | 10.7–19 s     | sample rate, channels  |
| Join + verify              | ~1 s        | ~1 s          | —                      |
| **Observed total**         | 4.6–11.9 s  | **17.8 s**    |                        |

The two dominant lines depend on nothing the user can change afterwards, so they cache
perfectly. Removing them leaves roughly **2.5–4 s of local work** for any source length, which
is what makes SC-001/SC-002 achievable with the transfer inside the same ten seconds.

**Alternatives considered**

- _Prepare nothing, rely on the tool being fast._ Rejected on the numbers: a 52-minute source
  spends 13.9 s before a single frame is written.
- _Prepare the finished screens too._ Rejected as a first cut. A screen depends on the drawn
  photo, the fit mode, the frame size **and** a hold length that is drawn at random per run.
  It is worth ~1.4 s. Recorded as a later refinement (D9), not built now.
- _Prepare whole finished files (pre-render every material re-stitched)._ Rejected: the photo
  is drawn per run, so the output is not reusable, and it would store a second copy of the
  entire library.

---

## D2 — Where the prepared artefacts live

**Decision**: split by size and by who needs them.

| Artefact                                     | Size                | Lives                          |
| -------------------------------------------- | ------------------- | ------------------------------ |
| What was found in a material (edges, layout) | a few hundred bytes | Supabase, against the material |
| The silence bank                             | ~2 MB per rate      | the agent's own cache          |
| The prepared body                            | as big as the video | the agent's own cache          |
| The space's working folder marker            | one record          | Supabase + the drive folder    |

**Rationale**: the inspection result is the valuable, portable half — it is tiny and it lets
_any_ member's agent skip 6.7–13.9 s of work on a material somebody else already looked at.
The body is the opposite: it is as large as the source, so shipping it through the drive costs
more transfer than the 1–2 s of work it saves. The agent already has `PreparedBodyCache` with
an LRU ceiling; that stays exactly where it is.

**Alternatives considered**

- _Everything on the drive, in the Soty folder._ Rejected: uploading and re-downloading a body
  is slower than re-cutting it, and it doubles the space's storage.
- _Everything local._ Rejected: a second member re-does the inspection the first one paid for,
  and the owner explicitly asked for a folder on the drive.

---

## D3 — What the Soty folder on the drive is actually for

**Decision**: create it, mark it, and put in it a `soty.json` describing the space's prepared
state. Nothing else today; it is reserved for later features, which is what the owner asked
for.

**The silence bank is not in it.** D2 places the bank in the agent's own cache and this
supersedes an earlier draft that listed it here. A bank is built once **per machine**, not once
per space, and it is rebuilt in 10.7–19 s — against roughly a second to fetch 2 MB, plus an
upload path, a per-sample-rate naming scheme and a cache-invalidation question, none of which
exist. The saving is real but small and it is paid once per member, ever; the complexity is
permanent. Local wins.

**Rationale for the folder itself**: the owner asked for a visible, systemic place for Soty's
working material and said other things would go there later. It is thin on day one and that is
fine — what makes it worth creating now is the marker and the resolution rule, not its
contents. Filling it with bodies would make it a liability (D2).

**Marking**: Drive's `appProperties` on the folder (`soty.workspace = "<team id>"`), not the
name. `appProperties` are private to the OAuth client, survive rename and move, and are
searchable — which is exactly FR-017. The folder's id is also cached on the space so the common
path is one read, with the property search as the recovery when the id is stale.

**Alternatives considered**

- _Find it by name (`Soty`)._ Rejected outright: a rename orphans it and a second folder
  called `Soty` steals it.
- _A `.soty` marker file inside it._ Rejected: costs a listing per lookup and is deletable by
  anyone tidying up.
- _Store the folder id only._ Rejected as the sole mechanism — a deleted-and-recreated folder
  leaves a dangling id with no way back. Id first, property search as the fallback.

**Nobody creates it by hand.** The button creates it, finds it again, and never asks. What is
missing is on our side, not the user's: `drive-ops` has no folder-creation action today (it has
upload, rename, move, copy, trash/restore, text edit, process), so one is added —
`ensure_workspace_folder` — on the same authorization path as the rest.

**The permission is already there.** The connection uses `drive.file`
(`supabase/functions/_shared/scopes.ts`), the non-restricted scope: no verification review, no
unverified-app warning. Under it an application may create files and folders, write
`appProperties` on what it created, and search by them within what it created — which covers
this folder exactly. The parent is the connection's `root_folder_id`, a folder the owner picked
themselves when they connected the drive. So no new scope, no re-consent, and no step for the
member.

The only moment anyone is told anything is when **no drive is connected at all**, and then they
are offered the existing connect flow rather than an instruction.

---

## D4 — Where the defaults are stored

**Decision**: a new table `public.team_restitch_defaults`, one row per team, reached through
`security definer` RPCs, following `team_share_preferences` exactly.

**Rationale**: that pair (`get_share_preference` / `set_share_preference`, RLS + narrow grants,
`set search_path = ''`) is the established shape for a team-scoped preference in this codebase,
and the constitution requires new surfaces to inherit the posture rather than open a hole
beside it. The only difference is the key: share preference is per `(team, user)`; these
defaults are per **team**, because the owner wants one answer for the space.

**Alternatives considered**

- _Reuse `team_contract_settings`._ Rejected: it is a global key/value for the release
  contract, not per-team data, and has no team scoping or RLS shape for this.
- _Keep the defaults on the agent._ Rejected: they are a property of the space, and a second
  member's agent would not have them.
- _Per-folder overrides._ Out of scope (spec).

---

## D5 — Which settings, exactly

**Decision**: the stitcher's own five, and nothing invented:

- operation — `restitch | stitch | unstitch`;
- start photo pool and end photo pool — ids from the compressor's image library;
- fit mode — `cover | contain | stretch`;
- end hold — the compressor's `FinalImageDurationMode` (`random-30-40 | random-40-50 |
random-50-60 | custom`) plus a custom length.

**Rationale**: "не вигадувати велосипед" was explicit. Every one of these already exists as a
shared type with shared bounds and clamps (`clampStitchEndDuration`,
`finalImageDurationRange`), which Principle I says to reuse rather than re-derive.

**Note on the photo pools**: the images themselves live in the agent's image store, not in the
space. The defaults record **which ids may be drawn**; if the acting member's agent does not
have an image, the run falls back to the remaining enabled ones and says so. This is the same
"library plus a draw" model the compressor already uses.

---

## D6 — How a re-stitched download actually runs

**Decision**: extend the existing agent download bridge. `POST /api/team/download` already
takes `compress?: { embed, suffix }` and runs a **delegate** locally between downloading the
source and saving it. Add a `stitcher` delegate and widen that field to a discriminated
`process?: { tool: 'compressor' | 'restitch'; … }`.

**Rationale**: the path already exists and is the one 013 chose for exactly this shape of act
(fetch from the space, work locally, land the file for the member). It carries the transfer
grant, cancellation, and the reveal-in-file-manager afterwards. Building a second path would
duplicate all of it.

**"Handed to the browser as a download"**: in this product the agent saves the file and reveals
it, because the bytes are already on the member's machine — pushing them through the browser
would be a second copy of the same file for no gain. What must change is that it may not ask
where to put it every time (see D7).

**Alternatives considered**

- _Stream the finished file back to the browser and let it save._ Rejected: doubles the
  transfer, loses the reveal, and there is no existing seam for it.
- _Run it as a team `process` operation and download the result afterwards._ Rejected: that
  writes the result into the space (the owner wants a download, not a new material) and adds an
  upload plus a catalog round trip to a ten-second budget.

---

## D7 — Not asking where to save, every time

**Decision**: remember, in the browser's own storage, the folder this member last chose for
this space, and use it without asking. Ask once, the first time, through the existing native
picker; offer "change" in the same settings section.

It is **per member per browser**, not a property of the space — a space cannot dictate where
somebody's files land, and two members on two machines want two different folders.

**Rationale**: `TeamDownloadBridge.download` calls `chooseDestination()` on every call, which is
a native dialog. The owner's flow is "click, watch a short progress, get the file" — a folder
dialog in the middle of a ten-second promise is the wrong shape. The picker still exists; it
just stops being per-click.

**Alternatives considered**

- _Always the system Downloads folder._ Rejected: the agent has no business writing outside a
  place the member chose, and the grant model here is "a folder the user picked".
- _Keep asking._ Rejected: it is the thing the owner is trying to remove.

---

## D8 — What "prepared" means per material, and when it stops being true

**Decision**: a `team_material_restitch_prep` row keyed by material, carrying the detected
edges, the source profile the cut needs, the `driveVersion` it was computed from, and when.
It is discarded when `driveVersion` changes.

**Rationale**: `TeamMaterialRow.driveVersion` already exists and already changes when content is
replaced — FR-022 needs no new plumbing. Keying on it also makes the record self-invalidating
for the "new version" and "overwrite" flows 013 introduced.

**Deliberately not part of the key**: the photos, the fit mode, the hold length, the operation.
Those are the settings a member changes daily, and none of them affect what was found in the
file — which is precisely why FR-006 can promise that changing the defaults keeps the
preparation valid.

---

## D9 — What is knowingly left out

- **Pre-built screen segments** (~1.4 s). Needs the hold length drawn in advance, or a bucketed
  set of pre-rendered lengths. Worth revisiting only after the rest is measured in the field.
- **Pre-downloading sources next to the agent.** It would remove the transfer from the ten
  seconds entirely, but it stores the whole library twice on the member's disk. Left as a
  possible per-material "keep a copy" later.
- **Batch preparation across members.** Preparation runs on the agent of whoever pressed the
  button; the _result_ is shared through Supabase, which is the part that matters.

---

## D10 — Performance budget for SC-001

For a prepared two-minute material, ten seconds is spent roughly:

| Phase                                    | Budget     |
| ---------------------------------------- | ---------- |
| Grant + transfer of a ~25 MB source      | 2–5 s      |
| Body cut/copy from the cached inspection | 1–2 s      |
| Two screens (300 pictures each)          | ~1.4 s     |
| Join + verify                            | ~1 s       |
| Save + reveal                            | <0.5 s     |
| **Total**                                | **6–10 s** |

The transfer is the only line that is not under this feature's control; it is also the reason
SC-002 is written as "does not grow with duration **beyond the transfer of its own bytes**".
The measurable claim to test in `quickstart.md` is the local half: **under 5 s** from source in
hand to finished file, for any length, once prepared.
