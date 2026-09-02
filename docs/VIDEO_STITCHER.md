# Video Stitcher — operational notes

The stitcher replaces, adds, or removes the static photo screens at the edges of a video
without re-encoding the video. Feature 014; the reasoning behind every choice below, with the
measurements that forced it, is in `specs/014-video-stitcher/research.md`.

## What it is made of

| Piece                             | Where                                                    |
| --------------------------------- | -------------------------------------------------------- |
| Contract, planner, bounds, guards | `packages/shared/src/stitcher.ts`                        |
| Lifecycle                         | `STITCH_LIFECYCLE` in `packages/shared/src/lifecycle.ts` |
| Argument builders (pure)          | `apps/agent/src/ffmpeg/stitch-presets.ts`                |
| Probe → `SourceProfile`           | `apps/agent/src/stitcher/probe.ts`                       |
| Detect + plan                     | `apps/agent/src/stitcher/plan.ts`                        |
| Prepared-body cache               | `apps/agent/src/stitcher/body-cache.ts`                  |
| Screens and silence               | `apps/agent/src/stitcher/segments.ts`, `silence.ts`      |
| The media half of a run           | `apps/agent/src/stitcher/pipeline.ts`                    |
| Queue, install, cancellation      | `apps/agent/src/stitcher/queue.ts`                       |
| Verification                      | `apps/agent/src/stitcher/verify.ts`                      |
| Routes                            | `apps/agent/src/stitcher/routes.ts`                      |
| Page                              | `apps/web/src/stitcher/`                                 |

## On-disk state

Everything lives under the agent's Application Support root (`Soty`, or `Soty Beta` in the
beta environment):

- `stitcher/state.json` — settings and the last 50 runs.
- `stitcher/silence/silence-<rate>-<channels>.aac` — the AAC silence banks, built once each.
- `stitcher/bodies/<key>.mp4` — prepared bodies, LRU-evicted against a 4 GB ceiling.

The body cache key includes a **format version**. Bump `PREPARED_BODY_FORMAT` in
`body-cache.ts` whenever how a body is produced changes, or a build that fixes a cut will
happily serve the bodies the previous build cut wrongly — which is exactly what happened once.

## Performance baseline

Measured through the agent's API on a 50-second 1080×1080 creative, machine under normal load:

| Operation                                              | Measured |
| ------------------------------------------------------ | -------- |
| Adding three files, one of them 52 minutes long        | 1.5 s    |
| Re-stitch, first touch of a file made elsewhere        | 4.8 s    |
| …the same, on a 52-minute source (inspection included) | 17.8 s   |
| Re-stitch, same body, new photo                        | 1.8 s    |
| Stitch a clean 20-second video                         | 1.8 s    |
| Remove the stitching                                   | 0.1 s    |
| Inspect (probe + edge detection), before any run       | 4.1 s    |

The run time does not grow with the screen's duration: a screen is capped at 300 pictures
however long it is held, so a 45-minute hold is 300 frames rather than 2700 — 1.4 s instead of
18.3 s.

**The inspection is the slowest part of a run**, and it happens _inside_ one. Reading a long
file's keyframe index costs about five seconds and searching it for existing screens another
six to nine, so doing either when a file was added meant staring at a spinner before the row
even appeared. Adding a file now costs one `ffprobe` of the container; the run's first stage,
`inspecting`, reads the index and looks for the screens. The total work is the same, it is
just spent where the user has already asked for it.

A dropped file's bytes are never sent either. `/api/stitcher/dropped` matches a file on disk
by name, size and modification time and drains the part without reading it, so the client
sends an empty placeholder carrying the real filename.

## Things that will bite

- **`-to` after an input `-ss` counts from the seek point.** Every cut here is expressed as a
  length (`-t`). The wrong form is the one that reads correctly.
- **B-frames on a 1 fps screen push DTS backwards by seconds.** Screens are encoded `-bf 0`.
  The symptom is a video track that ends seconds before its audio.
- **A looped image shorter than one frame period hangs FFmpeg.** The argument builder throws
  rather than spawning; do not route around it.
- **`ffprobe` profile names are not `-profile:v` values** (`Constrained Baseline`, `High 10`).
  `h264ProfileArgs` maps the ones x264 accepts and omits the flag otherwise.
- **A detection can swallow the whole video.** Footage that reads as static at the detector's
  sampling resolution once produced a 45-second photo with one frame of video attached, and
  the verification passed it because plan and output agreed about the same wrong thing.
  `believableDetection` keeps a body; it is the one rule the verification cannot supply.
- **The agent's CORS allowlist is `GET, POST, DELETE, OPTIONS`.** A `PATCH` route fails its
  preflight and the click silently does nothing.
- **A tail can be more than one picture.** A creative ends on its own held end card and then
  someone appends a photo screen after it. The search anchored on the _last_ frame of the file
  stops at the card — the card does not match the photo — so re-stitching left five seconds of
  the old stitching in front of the new screen. `heldTail` walks back through the tail one
  picture at a time. Two tests have to agree at each step: the visual run search, which is
  frame-accurate but reads a barely-animated card (a pulsing arrow) as motion, and the cost
  check, which knows a card is held but not where it starts.
- **What is called "the body" when measuring it still contains the card.** The figure for what
  a moving frame costs is sampled at 10/25/40% of the body — its opening — because sampling
  across the whole of it put two of three samples on a five-second card and compared the card
  against itself. A creative does not open on a held card.
- **A copy cut by length alone overshoots by four to six frames.** `-t` stops on a packet
  boundary and the frames that trail in presentation order come along, which on a body ending
  where an old card begins is that card showing in front of the new screen. The source is
  refused unless its frame rate is constant, so the cut is asked for as a number of pictures
  (`-frames:v`) with `-t` left to bound the audio.
- **A held photograph is cheap per frame, not per second.** `-read_intervals` seeks to a
  keyframe, so a two-second window over a photo screen is one enormous keyframe plus sixty
  frames of nothing. Averaged, a 50-minute screen measured 57 kB/s — more than the footage
  before it — and `stillEdge` threw it away, leaving the old screen in place and appending a
  second one. The median frame in that same window is 26 bytes. Compare medians, and sample
  the body from its **middle**: the seconds just before an end screen are the calmest of the
  whole creative, which is the least representative place to ask what the body costs.
- **A segment has two lengths and only one of them is the promise.** An MP4's container
  duration rounds up past its last sample. Concatenated, each part advances the timeline by
  its _container_ duration; left alone — a removal, where the body is the result — the file
  keeps the body's own _video track_ length. Promise the wrong one and a correct file fails
  its own verification by under a millisecond over tolerance. Both mistakes have been made.
- **A profile does not survive a restart, but the row does.** Rows are persisted; the probed
  profiles behind them are not. `/start` re-probes a row whose profile is gone — without that
  the whole list is unstartable after the agent restarts, and the button silently does
  nothing.
- **Every cache needs its identity in its key.** The prepared body carries a format version;
  the silence bank carries its length. Both caches have already served a stale artefact once.
- **Two non-monotonic DTS warnings** appear when re-muxing an output whose body carries
  B-frames. The file's duration, track agreement, frame count and seeking are all correct, and
  no flag on the concat step changes it. It is a seam artefact, not corruption.

## Releasing it

`WEB_TOOL_REQUIREMENTS.stitcher` is compared byte-for-byte against the signed `stable.json`
by `scripts/verify-release.mjs`, so `deploy:web` fails until an agent release publishes the
new map. The tool ships **with** an agent release, and the web page stays behind the
`videoStitcher` acknowledgement flag until it does.

## Checking it still works

```sh
npm run build -w @video-compressor/shared
npx vitest run tests/stitch-*.test.ts tests/stitcher-page.test.tsx \
  --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

`tests/stitch-integration.test.ts` runs the real media engine and skips (visibly) without it.
`specs/014-video-stitcher/quickstart.md` is the by-hand walk-through, including the numbers
above.
