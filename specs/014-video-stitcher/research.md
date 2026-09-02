# Phase 0 Research: Video Stitcher

**Date**: 2026-08-31 · **Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Everything below was measured, not assumed. The bench is the owner's own machine
(Apple silicon MacBook Air, load average ~3 during the runs), FFmpeg 9.0.1, with a
synthetic 1080×1080 / 30 fps / H.264 High / yuv420p / AAC 48 kHz stereo creative built the
way the current compressor builds one: a one-frame photo intro, 20 s of motion, a 30 s
photo outro, 7.4 MB, 50.03 s. Raw transcript of the runs is not kept; every number below is
a wall-clock figure from those runs.

---

## D1. Joining segments: the concat demuxer with `-c copy`, into MP4

**Decision**: build each piece as its own MP4 and join them with
`ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart`.

**Rationale**: measured at **0.036–0.11 s** for the whole join (7 MB output), zero decode
errors on a full `-f null -` pass, correct frame count, and — the finding that mattered —
the MP4 muxer wrote **one** `stsd` entry even though the screens' SPS/PPS differ from the
body's. FFmpeg carries the differing parameter sets in-band, so a single sample description
still decodes correctly; the classic "multiple sample entries break QuickTime" objection
does not apply to this route.

**Alternatives considered**:

- **MPEG-TS intermediates + the `concat:` protocol** (the usual "robust" folk recipe):
  measured **worse** — `Packet corrupt`, `timestamp discontinuity`, a wrong container
  duration (11.09 s where 8.06 s was expected) and **21 decode errors** on the same inputs.
  Rejected.
- **The `concat` filter**: re-encodes everything. That is exactly what this feature exists
  to stop doing. Rejected.

---

## D2. The end screen is encoded at 1 fps, not as a single long frame

**Decision**: the long end screen is `-loop 1 -framerate 1 -t D` — one picture per second
for D seconds — not one frame stamped with a D-second duration.

**Rationale**: measured on a 45-second 1080×1080 end screen:

| Variant | Encode time | Size | Seek/thumbnail at t=22 s |
| --- | --- | --- | --- |
| single frame, `-framerate 1/45` | **0.086 s** | 1.8 KB | **fails — no frame returned** |
| **1 fps (45 frames)** | **0.258 s** | 4.4 KB | **works** |
| body's own 30 fps (1350 frames) | **7.03 s** | 80 KB | works |

The single-frame trick is the fastest and is what the owner's brief proposed, but nothing
can seek inside it: a thumbnailer, a scrubbing player, or a platform that samples the middle
of the video gets nothing back. The 1 fps screen costs **0.17 s more** and removes the whole
class of problem, so it is the default rather than a fallback. The body's own frame rate
(7 s) would eat the entire 5-second budget by itself and is rejected outright.

**Alternatives considered**: single frame as an opt-in "fastest" mode — rejected as a
setting nobody can evaluate, which the simplicity decision in the spec rules out.

---

## D3. Every concat segment must carry at least two samples per track

**Decision**: the start screen is encoded as **two or more frames at the body's frame rate**
(≈ 66 ms at 30 fps), never as one sample.

**Rationale**: a one-sample MP4 video track has no sample-to-sample delta, and the muxer
wrote its duration as **1 tick** (1/15360 s). The concat demuxer then placed the next
segment on top of it: the start screen was measurably **invisible** in the output — a colour
probe at t=0.005 s returned the body's picture, not the screen's. Two samples make the
duration explicit and the screen appears. The end screen (D2) already has D samples and is
unaffected.

---

## D4. Silence comes from a pre-built ADTS bank, sliced by exact frame counts

**Decision**: build one AAC silence bank per (sample rate, channel layout) as raw **ADTS**
(`-f adts`), cache it, and cut each screen's silence with `-i bank.aac -frames:a N -c copy`.
Screen durations are snapped to a whole number of AAC frames (N × 1024 / sample rate).

**Rationale**: three measured effects, all of them fixed by this shape.

- Slicing with `-t D` returns the frame that *covers* D, so the audio came out longer than
  the video (5.013 s audio vs 5.000 s video). `-frames:a N` is exact.
- An `.m4a` bank carries encoder priming in an edit list; every segment cut from it started
  at +0.021 s, which the concat demuxer then baked into the timeline as a seam offset. ADTS
  has no edit list and no start-time — segments came out at `start_time=0.000000`.
- With N-frame slicing plus snapped durations, a segment's audio and video durations matched
  to the microsecond (5.013333 vs 5.013346), and the joined file's two tracks agreed
  (8.077344 vs 8.077333) instead of drifting apart.

Slicing costs **~0.03 s**; building the 60-second bank costs **0.2 s**, once.

---

## D5. Screens are rendered to the body's own parameters, including colour range

**Decision**: read the body's profile with `ffprobe` (width, height, pixel format, colour
range, frame rate, video timescale, audio sample rate / channels / codec) and encode the
screens to match, with the existing `imageAdaptationFilter` fit modes.

**Rationale**: a photo decoded from JPEG lands in **full-range** `yuvj420p`. Without
`in_range=full:out_range=tv` on the scale filter and `-color_range tv` on the encoder, the
screen segment carried `pix_fmt=yuvj420p` against a `yuv420p` body — a parameter mismatch at
the seam and a visible colour shift on the photo. With them, the joined file reported a
single clean `yuv420p / color_range=tv`.

The `-video_track_timescale 15360` from the owner's brief is not a magic number: it is
FFmpeg's own default for 30 fps (fps × 512). The rule that matters is **match the body's
timescale**, whatever it is, so the demuxer never has to rescale timestamps at a seam.

---

## D6. The body is prepared once per source; a head that is not on a keyframe is re-encoded

**Decision**: preparing a body is (a) a stream-copy remux with `-avoid_negative_ts make_zero
-muxdelay 0 -muxpreload 0` to zero its timestamps, plus (b) — only when the body's first
frame is not a keyframe — a re-encode of the single group of frames from the cut point to
the next keyframe, with the rest stream-copied. The result is cached, keyed on the source
file's identity, so every later photo against the same video is pure copying.

**Rationale**: this is the one place where the "never re-encode" ideal meets the container.
Measured on the legacy-style creative: **keyframes fell every 8.33 s (250 frames) and there
was no keyframe at the body's boundary** — x264's scene-cut detection did not fire at the
photo→motion transition. A copy cannot start mid-GOP, so the three options were: keep the
old photo frame (wrong output), start the body 8.3 s late (destroys content), or re-encode
the head. The head re-encode of 8.3 s at 1080×1080 measured **1.63 s** — affordable inside
the budget, paid **once per source video**, never again for further photos.

Videos this tool produces itself always begin their body at a keyframe, so re-stitching a
Soty-stitched file skips (b) entirely. Zeroing the timestamps also removed the body's
negative initial DTS (`dts=-1024` from B-frame reordering), which was the loudest source of
`Non-monotonic DTS` complaints at the seam.

**Consequence for the spec**: FR-009's "never re-encodes the moving content" needs the
bounded exception written into it — see the spec amendment noted in
[checklists/requirements.md](./checklists/requirements.md).

---

## D7. Verification after every run is mandatory, not decorative

**Decision**: every finished file is probed and compared against what was promised —
container duration, per-track durations, frame count, codecs, dimensions, pixel format — and
a mismatch beyond tolerance fails the job instead of handing the file over.

**Rationale**: the experiments produced exactly the drifts this catches. Nominal 8.056 s came
out as 8.077 s (+21 ms, one AAC frame); a run that mixed a 1 fps end screen with a
smart-cut body reported **video 63.25 s against audio 65.26 s** — a two-second track
disagreement that no user should ever receive. The 45 ms-class deviations are acceptable and
belong inside the tolerance; the 2-second class must fail. Probing costs ~0.02 s.

---

## D8. Never hand FFmpeg a looped image shorter than one frame period

**Decision**: forbid `-loop 1 -framerate F -t D` where `D < 1/F`; use the single-frame form
for anything below one frame period.

**Rationale**: `-loop 1 -framerate 1 -t 0.042667` **hung** — a 2-minute timeout, the machine's
load average driven from 3 to 13. The same hazard is already documented in
`apps/agent/src/ffmpeg/presets.ts` for the current embedding path; this feature must not
rediscover it in production.

---

## D9. Measured end-to-end budget

Re-stitching the 50-second 1080×1080 legacy creative — detect, prepare (with an 8.3 s head
re-encode), build both screens, join, verify:

| Step | Measured |
| --- | --- |
| Head re-encode (8.3 s of 1080×1080, only when the body is not keyframe-aligned) | 1.63 s |
| Tail stream copy (11.7 s) | 0.12 s |
| Both screens (1 fps end screen + silence slices + muxes) | 0.43 s |
| Join, `-c copy -movflags +faststart` | 0.11 s |
| Probe/verify | ~0.02 s |
| **Total, worst case (first touch of a legacy file)** | **≈ 2.3 s** |
| **Total, re-stitch of a prepared or Soty-made body** | **≈ 0.6 s** |

SC-001's five seconds holds with room to spare, and SC-002's "independent of screen
duration" holds because the end screen's cost is 45 frames of static picture regardless of
how long it is displayed.

---

## D11. `-to` after an input `-ss` counts from the seek point, not from the file

**Decision**: every cut is expressed as a length (`-t`), never as an end time (`-to`).

**Rationale**: found by the verification step on the first real run. `-ss 8.333 -i src -to 20.033`
does not produce the 11.7 seconds it reads like; FFmpeg measures `-to` from the seek point, so
the tail came out 20 seconds long and the finished file was 69.65 s against a promised 61.07 s.
Expressed as `-t 11.7` it is exactly right. The rule now has a test of its own, because the
wrong form is the one that reads correctly.

---

## D12. Screens are encoded without B-frames

**Decision**: `-bf 0` on every screen encode.

**Rationale**: a B-frame makes decode order lag presentation order by a frame or two. At the
body's 30 fps that is milliseconds; at the end screen's **one frame per second** it is two
whole seconds, and the screen's timestamps then run backwards into the body it is appended
to. Measured on a real creative: video track 58.31 s against an audio track of 60.27 s — a
file no one should ever receive. With `-bf 0` the same run produced 60.273 / 60.273, and a
colour probe inside the end screen returned the photo. A static picture gains nothing from
B-frames, so the cost is zero.

---

## D13. A detection that swallows the video is refused

**Decision**: whatever the edge detector reports, a body has to remain — at least one second
and at least 2% of the source. Otherwise nothing was found.

**Rationale**: run against a clean twenty-second clip of moving footage, the detector reported
a 19.93-second leading screen, and the tool produced a "creative" consisting of a
forty-five-second photo and one frame of video. **The verification passed it**, because the
plan and the output agreed with each other about the same wrong thing — which is the sharp
edge of checking a run against its own plan. The floor is the one rule the detector cannot
apply and the verification cannot catch. A boundary the user moved themselves is exempt: that
is a choice, not a detection.

---

## D14. `ffprobe` profile names are not `-profile:v` values

**Decision**: map `high`/`main`/`baseline`/`constrained baseline` and omit the flag for
anything else.

**Rationale**: `ffprobe` reports `Constrained Baseline`, `High 10`, `High 4:4:4 Predictive`.
Passing one through verbatim is not a near-miss, it is an invalid argument — FFmpeg exits
before encoding anything, and the run failed with a generic media error. Found by the
integration test the first time it ran against a fixture encoded with `-preset ultrafast`.

---

## D15. The prepared-body cache is keyed on its own format version

**Decision**: the cache key includes a format number, bumped whenever how a body is produced
changes.

**Rationale**: after the D11 fix the runs still failed, with the same wrong duration — the
cache was serving the body the previous build had cut incorrectly. A cache keyed only on the
source cannot tell "the same video" from "the same video, prepared by code that has since
been fixed".

---

## D16. Measured end to end, on the running agent

The numbers in D9 were measured on the pieces; these were measured through the agent's own
API on the same 50-second 1080×1080 creative, with the machine under its usual load:

| Run | Measured |
| --- | --- |
| Re-stitch, first touch (prepares the body, rebuilds one group of frames) | **4.8 s** |
| Re-stitch, same body, new photo | **1.1 s** |
| Stitch a clean 20-second video | **1.1 s** |
| Remove the stitching | **0.25 s** |
| Inspect (probe + edge detection), before any run | 4.1 s |

With the compressor's real ranges — a **40-to-50-minute** end screen — the same re-stitch
measures **4.3–5.5 s** warm, and **19 s** the very first time an audio shape is seen, because
that run also builds the hour-long silence bank. Every one of them verified clean.

Every one of them verified clean. SC-001's five seconds holds for the operations it names;
the inspection that precedes them is not part of that budget, but at four seconds it is the
slowest thing the user waits for and is the obvious next thing to make quicker.

---

## D17. A screen is capped by its picture count, not by its frame rate

**Decision**: a held screen gets at most **300 pictures**, and never more than one a second.

**Rationale**: the owner's requirement is the compressor's own ranges — the final image is held
for **30 to 60 minutes**, not seconds. D2's "one picture per second" does not survive that.
Measured on a 45-minute screen at 1080×1080:

| Variant | Encode time | Seekable |
| --- | --- | --- |
| 1 fps (2700 pictures) | **18.3 s** | yes |
| 300 pictures (one every 9 s) | **1.4 s** | yes |
| single frame | 0.17 s | **no** |

A 45-second screen still gets its full 45 pictures, because the cap is not reached. The rule
therefore keeps D2's finding (never a single frame) while making it survive a duration three
orders of magnitude larger.

---

## D18. The silence bank's length is part of its identity

**Decision**: the bank's file name carries its length, and a run asks for a bank long enough
for its own longest screen.

**Rationale**: exactly the failure of D15, in a second cache. When the end screen grew from
seconds to minutes the existing 320-second bank was still found and used, `-frames:a 135375`
returned what it had, and the finished file had 48 minutes of picture against 5 of sound. The
verification caught it — `tracks-disagree` — which is the only reason it was not shipped.

---

## D19. The agent's CORS allowlist decides which verbs exist

**Decision**: the settings route is `POST`, like the compressor's.

**Rationale**: `apps/agent/src/server/app.ts` allows `GET, POST, DELETE, OPTIONS`. A `PATCH`
never survives its preflight, the browser rejects it before the agent sees it, and the promise
rejects into a `void`. The visible symptom was that **every settings control on the page did
nothing at all** — no error, no state change. A verb that is not on that list is not available,
whatever the route says.

---

## D20. The screens are the compressor's, not a second copy

**Decision**: the stitcher reads and writes the compressor's `imageEmbedding` settings and its
image library through the compressor's own endpoints, and renders the compressor's own
`ImageEmbeddingSection`.

**Rationale**: the owner's instruction was literal — take it from the compressor. Beyond the
look, this removes a whole class of drift: one library, one fit mode, one set of duration
ranges, one place where a photo is added or disabled. The two controls that belong only to the
compressor (whether to embed at all, and "replace existing") are hidden here through one
`optional` prop rather than by forking the component — the stitcher always embeds, and decides
replacement from what it detects.

---

## D10. Where the code goes

**Decision**: a new agent tool module `apps/agent/src/stitcher/` implementing `ToolModule`,
a new web tool `apps/web/src/stitcher/` registered in `tool-registry.ts`, and new contract
types in `packages/shared/src/stitcher.ts`.

**Rationale**: the constitution's Principle V makes the tool module the unit of composition —
routes, the `/health` busy flag, cancellation and the shutdown chain all follow from
appending one entry to `createToolModules`. The compressor's own pipeline stays untouched,
which keeps the in-flight release safe. The screen image library
(`apps/agent/src/images/store.ts`), the static-edge detector
(`apps/agent/src/images/static-edges.ts`), the fit-mode filter (`imageAdaptationFilter`),
`spawnManaged`/`PowerGovernor`, and the compressor's destination and naming rules are reused
as-is rather than reimplemented.

**Alternatives considered**: a "no-compression mode" inside the compressor — rejected: it
would thread a second, incompatible pipeline through `JobQueue`, `EncodingSettings` and the
estimator, all of which exist to describe an encode that this feature never performs.
