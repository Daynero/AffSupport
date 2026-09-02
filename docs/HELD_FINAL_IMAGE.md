# The held final image

The compressor's final image runs to between thirty and sixty minutes. Encoded the obvious
way — one picture per frame period — that is fifty-four to a hundred and eight thousand copies
of a single photograph, and it dominated every run.

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
apart: below about two seconds it stays inside the main encode, where the saving is a handful
of frames and a join would cost two more processes.

Above it, an encode runs in three passes (`encodeWithHeldScreen`):

1. **Body.** The existing embedded filter graph with `endImagePath: null` — the source, the
   one-frame opening image, constant frame rate, exactly as before. This is the whole cost of
   the run, and the progress bar is scaled to it rather than to the finished length.
2. **The image**, as its own segment (`buildHeldScreenArgs`): a few hundred pictures spread
   over its duration, generated at that low rate rather than filtered down to it. The count
   comes from `endScreenFrameRate`, the rule the stitcher already uses — one picture a second
   while that is fewer than one per frame, evenly spread and capped at three hundred beyond.
3. **The join**, by the concat demuxer with a stream copy.

## Why three passes and not one filter graph

Because a single graph produces a file the compressor rejects itself. Joined with the `concat`
**filter**, FFmpeg writes a video track two picture-intervals shorter than its own audio —
measured at 11.9 s on a thirty-minute image — and `validateEmbeddedOutput` fails it on
`audio/video duration mismatch`. The image built on its own is exact at every length tried,
from five to forty-five minutes; the loss happens at the filter join, and a `-c copy` remux
afterwards does not repair it. A segment carries its duration in its own container, and the
concat demuxer honours it: the shipped path produces tracks that agree to **0.0 ms**.

## Things that will bite

- **`-bf 0` on the image.** A picture held nine seconds reorders decode against presentation
  by nine seconds, and the join then lands on a timestamp that has gone backwards. The
  stitcher found this first; here it costs nothing, because every picture is the same picture.
- **Never a single frame.** One picture would be faster still and nothing could seek inside
  it, which breaks scrubbing and thumbnails.
- **The average frame rate is no longer the answer.** A file that is mostly a held picture
  averages about two frames a second. `validateEmbeddedOutput` therefore judges such an output
  by `nominalFrameRate` — what the container declares the stream to be, which is the body's
  rate and the number that check was always meant to test.
- **Both halves share a timescale.** The body pass takes `videoTrackTimescale`, the image
  segment sets the same 15360, so the join is not counting time two ways.
- **A stop has to reach the current pass.** `encodeVideo` reports each child through
  `onChild`, and the queue re-points its activity at it; cancelling mid-body leaves no partial
  output, no `.body.mp4` beside the target, and no stray process.
