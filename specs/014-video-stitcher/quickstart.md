# Quickstart: proving the Video Stitcher works

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Measured baselines**:
[research.md](./research.md)

This is a validation guide, not an implementation guide. Every check below maps to a success
criterion and can be run by hand or from `tests/stitch-integration.test.ts`.

## Prerequisites

- Node ≥ 22.12, the repo's dependencies installed.
- FFmpeg and ffprobe available (`ffmpeg -version`). Packaged builds use `runtime/bin`;
  in development they come from `PATH`.
- Shared rebuilt before anything reads the contract:
  `npm run build -w @video-compressor/shared`.
- This machine is slow: run one heavy process at a time, check `uptime` first, and give
  vitest `--maxWorkers=1 --minWorkers=1 --no-file-parallelism`.

## Fixtures

Two videos and two photos are enough to exercise every path. Build them once into a scratch
directory (not the repo):

- **`legacy.mp4`** — a creative in the shape the current compressor produces: a one-frame
  photo intro, ~20 s of motion, a ~30 s photo outro, encoded in one pass at 1080×1080 /
  30 fps / H.264 High / yuv420p / AAC 48 kHz stereo. This is the file whose body does **not**
  start on a keyframe, so it exercises the head re-encode (D6).
- **`clean.mp4`** — the same motion with no screens at all.
- **`photo-a.jpg`**, **`photo-b.jpg`** — one square, one wide, so the fit modes matter.

## Checks

### 1. Re-stitch — US1, SC-001, SC-002, SC-003

Run the tool on `legacy.mp4` with a new start and end photo.

- The one-line preview names what was found (a leading screen and a trailing screen, with
  their lengths) and the length of what will be produced — before anything runs.
- The finished file appears in under **5 seconds**; the reported elapsed time is in the
  neighbourhood of the **2.3 s** measured in D9 for a first touch.
- `ffprobe` on the output: duration and frame count match what the preview promised (within
  one AAC frame plus one video frame), video and audio track durations agree with each other,
  codecs / size / pixel format equal the source's.
- Re-run the same re-stitch with a different photo: it now costs about **0.6 s** — the body
  was prepared once (FR-018).
- A colour probe inside the middle section matches the source's — the body was not re-encoded
  beyond the head (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 …`).

### 2. Screen duration does not cost time — SC-002

Run the same re-stitch twice, once with a 3-second end screen and once with 45 seconds. The
two elapsed times must be within ~10% of each other. (Baseline: the 45-second 1 fps end
screen encodes in **0.26 s**.)

### 3. Seekability — SC-004, D2

Probe a frame from the middle of the end screen:
`ffmpeg -ss <end-screen midpoint> -i out.mp4 -frames:v 1 -f rawvideo -pix_fmt rgb24 -`.
It must return a frame with the photo's colour. An empty result means someone reintroduced
the single-frame end screen — the variant D2 rejected.

### 4. Stitch a clean video — US3

Run on `clean.mp4`. The tool must infer `stitch` (nothing found) without asking, and the
output's duration must equal the source plus both screens. Try each fit mode against the wide
photo and confirm the picture is never stretched out of proportion (FR-015).

### 5. Remove the stitching — US4, SC-006

Un-stitch `legacy.mp4`: the output contains only the moving content, and its duration matches
the source minus the detected screens to within one frame. Ask to un-stitch `clean.mp4`: the
tool reports there is nothing to remove and writes no file (FR-008).

### 6. Batch — US2, SC-005

Queue one video against several photos. Each output is named distinctly, each has its own
screens, all share the same body, and one deliberately broken item (delete its photo
mid-batch) fails alone without stopping the rest (FR-020).

### 7. Refusing what it cannot serve — FR-023, FR-024

Feed a video the fast path cannot take (re-encode `clean.mp4` to HEVC, or to a variable frame
rate). The tool must decline with one sentence naming the reason and pointing to the
compressor, must not start a slow fallback, and must leave the file untouched.

### 8. Nothing is ever damaged — SC-008

- Cancel a run mid-flight: no partial file in the destination, source untouched, the temp
  directory gone.
- Choose "overwrite" and force a failure (make the destination read-only): the original
  survives byte-for-byte.
- Fill the destination or point it at a removed volume: a named failure, no half-written file.

### 9. Simplicity — SC-007

From a picked video, a first successful re-stitch must take **no more than three actions**
(choose photo → start → done), with no new configuration for a user who already uses the
compressor.

## Automated equivalents

| Check | Test |
| --- | --- |
| 1, 3, 4, 5 | `tests/stitch-integration.test.ts` (real FFmpeg, `it.skipIf(!available)` — never a silent `return`) |
| Plan maths, AAC snapping, operation inference | `tests/stitch-plan.test.ts` |
| Argument builders, including the sub-frame loop guard (D8) | `tests/stitch-presets.test.ts` |
| Tolerance boundaries — ~60 ms passes, 2 s fails | `tests/stitch-verify.test.ts` |
| Routes and error codes | `tests/stitch-routes.test.ts` |
| 6, 8 (cancellation, failure isolation) | `tests/stitch-queue.test.ts` |
| 9 and the preview line | `tests/stitcher-page.test.tsx` (jsdom) |

## Gates before a PR

`npm run format:check`, `npm run lint`, then the focused stitcher tests, then the full
`npm test`. Because CI never builds `apps/agent`, run `npm run build -w
@video-compressor/agent` to catch its type errors. Do **not** run `npm run verify` on this
machine.
