# The held final image

The compressor's final image runs to between thirty and sixty minutes. Encoded the obvious
way — one picture per frame period — that is fifty-four to a hundred and eight thousand copies
of a single photograph, and it dominated every run. It is still one picture per frame period,
because a re-encoder downstream reads the file's average rate; what changed twice is how those
frames come to exist.

## What it cost

Measured on an M1, a 2:03 source at 1080×1080 compressed to the optimal preset (720×720,
30 fps, CRF 26, x264 `slow`):

| Final image      | Before | After |
| ---------------- | ------ | ----- |
| none (body only) | 68 s   | 68 s  |
| 5 minutes        | 142 s  | 62 s  |
| 15 minutes       | 280 s  | 58 s  |
| 45 minutes       | ~700 s | 66 s  |

The model before was **68 s + 14.1 s per minute of image**; after, the image is free and the
run costs what the body costs. A real job through the agent on the default 30–40 minute range
went from roughly nine minutes to **73 s**.

The encoder was never the bottleneck. Timed on its own, sixty seconds of a held still at
720×720 costs 11.4 s, of which the filter graph — loop, scale, fps, format — is 8.3 s. x264
contributes three. What was expensive was manufacturing the frames at all.

## How it works now

`heldFinalImageSeconds` decides whether the image is held long enough to be worth building
apart: below two seconds (`HELD_SCREEN_MIN_SECONDS`) it stays inside the main encode, where
the saving is a handful of frames and a join would cost more processes.

Above it, an encode runs in passes (`encodeWithHeldScreen`):

1. **Body.** The existing embedded filter graph with `endImagePath: null` — the source, the
   one-frame opening image, constant frame rate, exactly as before. This is the whole cost of
   the run, and the progress bar is scaled to it rather than to the finished length.
2. **The image**, as its own segment, **at the body's frame rate** — one picture per frame
   period for as long as it is held. It is assembled, not encoded (`buildHeldPicture` in
   `apps/agent/src/ffmpeg/held-picture.ts`, next section), then given its silence
   (`buildHeldScreenMuxArgs`).
3. **The join**, by the concat demuxer with a stream copy.

The stitcher builds its end screen the same way (`stitcher/segments.ts`), from the same
module, so both tools hold an image identically.

## Constant frame rate (2026-11-19)

Until this date the image was "a few hundred pictures spread over its duration": one a
second, capped at three hundred. That made every finished file variable-rate with an average
of one to five frames a second — and **Facebook re-encodes an upload to a constant rate taken
from that average**. Measured on real uploads
(`docs/incidents/2026-11-19-facebook-low-fps.md`):

| File                                       | Average fps | What Facebook made |
| ------------------------------------------ | ----------- | ------------------ |
| 116 s body at 30 fps, ~52 min sparse image | 1.16        | 30 fps             |
| 186 s body at 60 fps, ~40 min sparse image | 4.46        | **5 fps**          |
| the same body, image at 60 fps             | 60          | 30 fps             |

A very low average is evidently distrusted and replaced with thirty; a plausible one is
believed, and the moving part is decimated to a slideshow. Long bodies and sixty-frame bodies
landed in the believed range. A file whose image runs at the body's rate has one rate, and
that is the rate it is given back at.

### How eighty thousand frames cost a second

Encoding them is what the sparse image was invented to avoid (seven hundred seconds for
forty-five minutes), and repeating a short encoded piece does not work either: every piece
has to begin with a full picture, a full picture of a detailed photograph is half a megabyte,
and one a minute outweighs the body.

What the assembly uses instead is that x264's empty frames repeat **byte for byte**:

- With `zones=1,N,q=51` every picture after the first is quantised so coarsely that each
  unchanged macroblock is skipped: an "empty repeat" of about 43 bytes at 1080×1080. Without
  the zone x264 keeps refining a still for as long as it is given frames, at about half a
  kilobyte each.
- Nothing in those repeats changes but a four-bit frame counter, so their bytes recur with a
  short period — thirty-two frames, measured. The last eight or so frames of any run differ
  (the encoder's lookahead draining) and are never used.
- So a **seed** of 209 frames is encoded once, its period is _measured_ from packet hashes
  (`ffprobe -show_data_hash`), and two pieces are cut from it: the **head** (the picture and
  one period) and the **cycle** (the next period alone — a file with no keyframe, which is
  what `-copyinkf` is for). The cut is trusted only when the cycle's hashes are the measured
  period's.
- The screen is then stream copies: thirty-two cycles make a block, a head and blocks make a
  group of nine thousand frames (`HELD_PICTURE_GOP_FRAMES`), and groups make the screen. The
  last copy restamps every picture by counting (`-bsf:v setts`), so picture N is at exactly N
  frame periods.

The result is the stream x264 would have written had it been left running. Measured with the
bundled FFmpeg 7.1.1 at 1080×1080: forty minutes at 30 fps in **1.3 s**; at 60 fps in 1.6 s.

Anything that does not measure as expected — a seed that does not repeat, a cut that landed
elsewhere, a copy that failed — sends the screen down the long road: every frame encoded.
Slower, and always correct. A cancellation is not such a failure and stops the run there.

### What it weighs

Forty minutes at 1080×1080: 3.1 MB of repeats at 30 fps (twice that at 60), plus one full
picture per group — eight of them, from about 0.1 MB for a product on white to 0.6 MB for a
detailed photograph. Measured end to end on a real creative: 73.5 MB before, 88.9 MB after
(60 fps, detailed photograph — the heavy corner); a 720p compression went from 4.1 MB to
9.3 MB. The time did not change: 15.8 s → 14.8 s for the re-stitch, 9.7 s → 10.3 s for the
compression.

The one picture carries the whole screen, so it is encoded at `HELD_PICTURE_CRF` (15) rather
than at the job's rate control: the sparse image used to get a very low quantiser for free,
because x264 scales its rate factor by how long a frame is shown.

Writing the repeats without CABAC would make them 12 bytes instead of 43. It also puts a
second entropy mode into one track, which is exactly the kind of mid-track disagreement
stricter players have refused before; it stays untried until it has been played on phones.

### Reading such a file back

Seeking into a group makes a decoder walk every repeat since the last full picture — up to
nine thousand of them. A player does that once per seek (under two seconds on an M1). The
static-edge search asks for dozens of frames, so it reads the packet table first
(`repeatIndexFromProbe`): a non-keyframe that follows its predecessor in both orders and is
too small to hold anything but skipped macroblocks is a repeat, and the picture its run began
with is decoded in its place — once. Finding a forty-minute screen takes two seconds.

The compressor's size estimate uses the same structure (`heldPictureBytes`): two short
samples give the size of the picture and of one repeat, and the rest is a count. The old
six-second sample priced every second like the first six and promised ten times the file.

## Why separate passes and not one filter graph

Because a single graph produces a file the compressor rejects itself. Joined with the `concat`
**filter**, FFmpeg writes a video track two picture-intervals shorter than its own audio —
measured at 11.9 s on a thirty-minute image — and `validateEmbeddedOutput` fails it on
`audio/video duration mismatch`. The image built on its own is exact at every length tried,
from five to forty-five minutes; the loss happens at the filter join, and a `-c copy` remux
afterwards does not repair it. A segment carries its duration in its own container, and the
concat demuxer honours it: the shipped path produces tracks that agree to **0.0 ms**.

## Things that will bite

- **`-bf 0` on the image.** The screen is assembled from its own repeats by stream copy, which
  needs decode order and presentation order to be the same order. Every picture is the same
  picture, so B-frames have nothing to give.
- **Never a single frame, and never one keyframe for the whole screen.** Nothing could seek
  inside the first, and a seek into the second would decode forty minutes of repeats.
- **Files made before 2026-11-19 are still sparse.** A file that is mostly a held picture
  averages about two frames a second, and its nominal rate can describe the sparse tail too.
  `probeMedia` therefore still measures the moving cadence when the two disagree, and
  `validateEmbeddedOutput` still trusts that measurement first.
- **Both halves share a timescale.** The body pass takes `videoTrackTimescale`, the image
  pieces are written with the same 15360 (`HELD_SCREEN_TIMESCALE`), so the join is not
  counting time two ways.
- **A stop has to reach the current pass.** `encodeVideo` reports each child through
  `onChild` — the seed, each copy, the mux — and the queue re-points its activity at it;
  cancelling leaves no partial output, no `.body.mp4` beside the target, and no stray process.

## Compressor preparation and frame-rate reduction (2026-10-16)

Two further sources of repeated work are removed:

- Estimation and compression share completed static-edge trim scans. The bounded cache holds
  at most 64 results and checks file identity, size, nanosecond modification/change times,
  duration and frame rate. A changed file, failed scan or cancelled caller cannot seed a
  reusable result. Concurrent callers retain independent cancellation.
- For ordinary compression with a known source FPS above the requested FPS, the `fps` filter
  runs before scaling. Discarded frames no longer need scaling. Unknown/equal/lower source FPS
  retains the original order. Estimates use the same ordering as the final encode.

The embedded-image graphs, x264 `slow` preset, quality, audio policy, queue concurrency and
power-governor behavior remain unchanged.

Local synthetic measurements (wall time, not a production guarantee):

| Work                                | Before                      | After                | Method                          |
| ----------------------------------- | --------------------------- | -------------------- | ------------------------------- |
| Repeat static-edge analysis         | 1327 ms, 10 FFmpeg children | 0.17 ms, no children | One cold/warm pair              |
| 1920×1080, 60→30 FPS                | 2182 ms                     | 2151 ms              | Median of four runs per variant |
| 720×1280, 120→30 FPS                | 1915 ms                     | 1440 ms              | Median of four runs per variant |
| Variable FPS below target (control) | 976 ms                      | 973 ms               | Median of four runs per variant |

The paired compression runs alternate old/new order, use three-second sources, resolution
limit 720, CRF 26 and the production `slow` preset. The control keeps the same filter order;
its small difference is noise. The largest measured reduction is 24.8%, while the landscape
case gains only 1.4%. Long clips and other machines may behave differently.

Regression coverage compares decoded video/audio frame hashes, media metadata, output size
and exact estimate-sample bytes for landscape, portrait, fractional FPS and variable FPS.
Queue coverage exercises reuse after preparation and retains cancellation, held-image,
estimate and power integration checks. See `tests/compressor-filter-order.test.ts`,
`tests/static-edge-cache.test.ts` and `tests/static-edges.test.ts`.

Existing correlated compression/estimate lifecycle signals remain the diagnostic seam.
Cache hits and per-filter timing are not emitted; the coverage registry records this blind
spot. Local timings must not be reported as observed production improvement.
