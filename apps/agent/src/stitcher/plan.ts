/**
 * Everything that happens before a job exists: read the source, find its screens, and turn
 * both into the plan the user is shown and the run is checked against.
 *
 * The detector is the compressor's own — the same runs of visually identical frames it
 * already finds at both edges — so a video the compressor recognises as embedded is
 * recognised here too, without a second opinion to keep in step.
 */

import {
  believableDetection,
  STITCH_MIN_BODY_SECONDS,
  clampStitchEndDuration,
  planStitch,
  randomFinalImageDurationSeconds,
  startImageDurationSeconds,
  type DetectedStitching,
  type ImageAsset,
  type ImageEmbeddingSettings,
  type SourceProfile,
  type StitchOperation,
  type StitchPlan,
  type StitchPlanFailure,
  type StitchScreens
} from '@video-compressor/shared';
import { staticEdgeScan, type StaticEdgeScan } from '../images/static-edges.js';
import { ffprobePath } from '../ffmpeg/tools.js';
import { runTool, toolSucceeded } from './run.js';
import { probeSource, type ProbeFailure } from './probe.js';

export interface InspectionRequest {
  path: string;
  screens: StitchScreens;
  operation?: StitchOperation;
  /** Boundaries the user moved; when absent the detector's own findings are used. */
  boundaries?: { startSeconds: number; endSeconds: number };
  signal?: AbortSignal;
}

export interface Inspection {
  profile: SourceProfile;
  detected: DetectedStitching;
  plan: StitchPlan;
}

export type InspectionFailure =
  { kind: 'probe'; error: ProbeFailure } | { kind: 'plan'; error: StitchPlanFailure };

export async function detectStitching(
  profile: SourceProfile,
  signal?: AbortSignal
): Promise<DetectedStitching> {
  // One scan, one set of decoded frames: the trims and the walk back through the tail all
  // converge on the same two transitions.
  const scan = staticEdgeScan(profile.path, profile.durationSeconds, profile.frameRate, signal);
  const trims = await scan.trims();
  /*
   * Both edges are checked the same way: a start screen is a flash of a photograph, and a
   * second and a half of real footage is not one either.
   *
   * Both checks are told where the body is, because each needs to sample it and neither can
   * work that out from its own edge alone.
   */
  const body = {
    from: trims.startSeconds,
    to: profile.durationSeconds - trims.endSeconds
  };
  const moving = await bodyFrameBytes(profile, body, signal);
  const [startSeconds, endSeconds] = await Promise.all([
    stillEdge(profile, trims.startSeconds, 'start', moving, signal),
    stillEdge(profile, trims.endSeconds, 'end', moving, signal)
  ]);
  /*
   * A tail can be more than one picture, and only the last of them is visible to the search
   * above: a creative that ends on its own held end card and then has a photo screen appended
   * after it leaves the card sitting between the body and the new screen. Walk back through
   * whatever else is being held there.
   */
  const tail =
    endSeconds > 0 && moving !== null
      ? await heldTail(profile, scan, endSeconds, startSeconds, moving, signal)
      : endSeconds;
  return { startSeconds, endSeconds: tail, adjustedByUser: false };
}

/**
 * Is the detected trailing run actually a held photograph?
 *
 * The edge detector compares 32×32 grey samples, and ordinary footage — a dim scene, a locked
 * camera, a slow pan — can read as identical at that resolution. It once reported 116 seconds
 * of a two-minute video as a screen, and the tool duly threw the video away and kept four
 * seconds of it.
 *
 * A held photograph costs the encoder almost nothing *per frame*: after the keyframe that
 * carries the picture, every frame that follows is a few dozen bytes saying "again". So this
 * compares the typical frame in the suspected screen with the typical frame in the body. One
 * short read of the packet index each, no decoding.
 *
 * Two things this got wrong, both on real files:
 *
 * - **It measured bytes per second.** `-read_intervals` seeks to a keyframe, so a two-second
 *   window over a screen is one large keyframe plus sixty tiny frames, and its *rate* is
 *   dominated by the one frame that is not typical of it at all. A 50-minute photo screen
 *   measured 57 kB/s that way — above the body it was being compared with — and was thrown
 *   away. The median frame in the same window is 26 bytes. The median is the honest figure
 *   because exactly one frame in the window is a keyframe.
 * - **It sampled the body next to the boundary.** The last seconds before an end screen are
 *   the calmest of the whole creative — a shot settling, a held final frame — so the body
 *   was measured at its least typical. It is sampled from the middle of the body instead.
 */
async function stillEdge(
  profile: SourceProfile,
  seconds: number,
  edge: 'start' | 'end',
  moving: number | null,
  signal?: AbortSignal
): Promise<number> {
  // Nothing found, or a screen short enough that being wrong costs a frame or two.
  if (seconds <= 2) return Math.max(0, seconds);

  const boundary = edge === 'start' ? seconds : profile.durationSeconds - seconds;
  if (boundary <= 2 || boundary >= profile.durationSeconds - 2) return 0;
  // Nothing measurable between the two edges; the detector is on its own.
  if (moving === null || moving <= 0) return seconds;

  /*
   * Sampled from a keyframe, not from an arbitrary time.
   *
   * `-read_intervals 20.5%+2` does not start at 20.5 — ffprobe seeks to the keyframe before
   * it, which on a file with eight-second groups is four seconds earlier and on the wrong
   * side of the boundary. Read from a keyframe that is definitely inside the region and the
   * window says what it is supposed to say.
   */
  const inScreen =
    edge === 'start'
      ? lastKeyframeBefore(profile, boundary)
      : firstKeyframeAfter(profile, boundary);
  if (inScreen === null) return seconds;

  const screen = await typicalFrameBytes(profile.path, inScreen, 2, signal);
  // Unreadable: believe the detector rather than refuse on a probe failure.
  if (screen === null) return seconds;
  return screen <= moving * STILL_FRAME_SHARE ? seconds : 0;
}

/**
 * Everything else held at the tail, behind the screen that was found.
 *
 * One step per picture: find the run of identical frames that ends where the tail currently
 * begins, and take it too if it is as cheap as a held picture should be. Both tests have to
 * agree. The visual one is frame-accurate but reads a barely-animated end card — a black
 * screen with a pulsing arrow — as motion; the cost one knows the card is a held picture but
 * cannot say where it starts. Together they cut the card and stop at the footage before it.
 */
async function heldTail(
  profile: SourceProfile,
  scan: StaticEdgeScan,
  endSeconds: number,
  startSeconds: number,
  moving: number,
  signal?: AbortSignal
): Promise<number> {
  let boundary = profile.durationSeconds - endSeconds;
  // However calm a creative is, its tail is a tail. This is the ceiling on being wrong.
  const floor = Math.max(
    startSeconds + STITCH_MIN_BODY_SECONDS,
    boundary - Math.max(10, boundary * 0.1)
  );
  for (let step = 0; step < MAX_TAIL_PICTURES; step += 1) {
    if (boundary - floor < MIN_TAIL_PICTURE_SECONDS) break;

    const run = await scan.runEndingAt(boundary - 1 / profile.frameRate, boundary - floor);
    if (run < MIN_TAIL_PICTURE_SECONDS) break;

    /* Measured from where the run begins. ffprobe seeks back to the keyframe before it, which
       for a picture the encoder cut to is the picture's own first frame; when it is not, the
       window carries real frames, reads expensive, and the run is left alone. */
    const from = boundary - run;
    const held = await typicalFrameBytes(profile.path, from, Math.min(2, run), signal);
    if (held === null || held > moving * HELD_PICTURE_SHARE) break;
    boundary = await snapToPictureStart(profile, from, moving, signal);
  }
  return roundToFrame(profile, profile.durationSeconds - boundary);
}

/**
 * A picture the encoder cut to begins on a keyframe.
 *
 * The visual search stops at the first frame that differs from the one it is holding, and the
 * opening frames of a card can differ — an arrow that starts its animation, a one-frame fade.
 * That left a third of a second of the old card in front of the new screen. So when the run
 * begins just after a keyframe, take the frames between as well, but only once they have been
 * measured: on a creative whose keyframes fall on round seconds the frame before a card can
 * just as easily be a second of the body, and that must not be swallowed.
 */
async function snapToPictureStart(
  profile: SourceProfile,
  from: number,
  moving: number,
  signal?: AbortSignal
): Promise<number> {
  const keyframe = lastKeyframeBefore(profile, from);
  const gap = keyframe === null ? 0 : from - keyframe;
  if (keyframe === null || gap <= 0 || gap > KEYFRAME_SNAP_SECONDS) return from;
  const between = await typicalFrameBytes(profile.path, keyframe, gap, signal);
  return between !== null && between <= moving * HELD_PICTURE_SHARE ? keyframe : from;
}

/** Seconds the source can actually express, so a boundary is never half a frame. */
function roundToFrame(profile: SourceProfile, seconds: number): number {
  if (!(profile.frameRate > 0)) return seconds;
  return Math.round(seconds * profile.frameRate) / profile.frameRate;
}

/** How far before a run a keyframe may sit and still be taken as the picture's first frame. */
const KEYFRAME_SNAP_SECONDS = 1;

/**
 * What a card behind the screen may cost, against the body's typical frame.
 *
 * Looser than `STILL_FRAME_SHARE`, and deliberately: that one has to be sure a 50-minute hold
 * is a photograph, and a photograph costs 2% of a moving frame. A card is a rendered graphic
 * with a pulsing arrow on it — measured at 17% of the body on the file this was written for,
 * where the calmest real shot in the same creative measured 50%. The gap between those two is
 * what this sits in.
 */
const HELD_PICTURE_SHARE = 0.35;

/** At most this many held pictures behind the screen, so a calm creative cannot be walked away. */
const MAX_TAIL_PICTURES = 3;

/** Shorter than this is a cut, not a card. */
const MIN_TAIL_PICTURE_SECONDS = 1;

/**
 * What a frame of the moving part costs, in bytes.
 *
 * Three places rather than one: sampled at a single point the figure is whatever that moment
 * happens to be doing, and the moment right before an end screen — where this used to sample —
 * is the calmest of the whole creative.
 *
 * All three sit in the **opening** of the body, and that is the point. What is called the body
 * here is everything the trailing search did not claim, which still contains any held card in
 * front of the screen — the very thing being looked for. Sampled across the whole of it, a
 * five-second card in an eleven-second body took two of the three samples and the figure came
 * back as the cost of the card, so the card was compared against itself. A creative does not
 * open on a held card.
 */
async function bodyFrameBytes(
  profile: SourceProfile,
  body: { from: number; to: number },
  signal?: AbortSignal
): Promise<number | null> {
  if (body.to - body.from < 2) return null;
  const span = body.to - body.from;
  const measured: number[] = [];
  for (const share of [0.1, 0.25, 0.4]) {
    const at = keyframeNear(profile, body.from + span * share);
    if (at === null) continue;
    const bytes = await typicalFrameBytes(profile.path, at, 2, signal);
    if (bytes !== null) measured.push(bytes);
  }
  if (!measured.length) return null;
  measured.sort((left, right) => left - right);
  return measured[Math.floor(measured.length / 2)] ?? null;
}

/** A held photograph measured 2% of the body's typical frame; real footage measured 100%. */
const STILL_FRAME_SHARE = 0.15;

function firstKeyframeAfter(profile: SourceProfile, time: number): number | null {
  return profile.keyframeTimes.find(candidate => candidate > time + 0.05) ?? null;
}

function lastKeyframeBefore(profile: SourceProfile, time: number): number | null {
  const found = [...profile.keyframeTimes].reverse().find(candidate => candidate < time - 0.05);
  return found ?? null;
}

/** The keyframe closest to a time, from either side — the middle of the body has neither. */
function keyframeNear(profile: SourceProfile, time: number): number | null {
  let best: number | null = null;
  for (const candidate of profile.keyframeTimes) {
    if (best === null || Math.abs(candidate - time) < Math.abs(best - time)) best = candidate;
  }
  return best;
}

/**
 * The median video packet in a short window, in bytes.
 *
 * The median rather than the mean: the window begins on a keyframe, so one of its ~60 frames
 * is enormous and the other fifty-nine say what the picture is actually doing. See
 * `stillEdge` for what averaging that one frame in did to a real file.
 */
async function typicalFrameBytes(
  input: string,
  from: number,
  seconds: number,
  signal?: AbortSignal
): Promise<number | null> {
  const result = await runTool(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-read_intervals',
      `${from.toFixed(3)}%+${seconds.toFixed(3)}`,
      '-show_entries',
      'packet=size',
      '-of',
      'csv=p=0',
      input
    ],
    { signal }
  );
  if (!toolSucceeded(result)) return null;
  const sizes: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const size = Number.parseInt(line.trim().replace(/,+$/u, ''), 10);
    if (Number.isFinite(size)) sizes.push(size);
  }
  if (sizes.length < 3) return null;
  sizes.sort((left, right) => left - right);
  return sizes[Math.floor(sizes.length / 2)] ?? null;
}

/**
 * Probe, detect, plan — the three steps behind the single line the user sees.
 *
 * Boundaries the user moved replace the detector's, and are clamped to the source: an
 * adjustment can refine what was found but cannot ask for a body longer than the file.
 */
export async function inspectSource(
  request: InspectionRequest
): Promise<{ ok: true; value: Inspection } | { ok: false; error: InspectionFailure }> {
  const probed = await probeSource(request.path, { signal: request.signal });
  if (!probed.ok) return { ok: false, error: { kind: 'probe', error: probed.error } };
  const profile = probed.value;

  const detected = request.boundaries
    ? {
        startSeconds: clamp(request.boundaries.startSeconds, 0, profile.durationSeconds),
        endSeconds: clamp(request.boundaries.endSeconds, 0, profile.durationSeconds),
        adjustedByUser: true
      }
    : await detectStitching(profile, request.signal);

  const planned = planStitch(profile, detected, request.screens, request.operation);
  if (!planned.ok) return { ok: false, error: { kind: 'plan', error: planned.error } };
  // The line the user reads must describe the run that will happen, so it reports the
  // detection the plan acted on rather than the detector's raw opinion.
  return {
    ok: true,
    value: { profile, detected: believableDetection(profile, detected), plan: planned.value }
  };
}

/**
 * The screens a job will use, drawn from the compressor's own library and settings.
 *
 * The same `freezeImageEmbedding` the compressor runs before an encode: a random enabled
 * image per slot, and the final duration drawn once from the chosen range. A caller may pin
 * either image — the interface does, so the photo the user clicked is the photo that is used —
 * and the drawn duration is carried from the preview into the run so the promised length is
 * the produced one.
 */
export function screensFromEmbedding(
  embedding: ImageEmbeddingSettings,
  choice: {
    startImageId?: string | null;
    endImageId?: string | null;
    endDurationSeconds?: number | null;
  } = {},
  random: () => number = Math.random
): StitchScreens {
  const pick = (assets: readonly ImageAsset[], pinned: string | null | undefined) => {
    if (pinned === null) return null;
    if (pinned) return assets.find(asset => asset.id === pinned) ?? null;
    const usable = assets.filter(asset => !embedding.disabledImageIds.includes(asset.id));
    if (!usable.length) return null;
    return usable[Math.floor(Math.min(0.999999999, Math.max(0, random())) * usable.length)] ?? null;
  };

  const start =
    embedding.startEnabled === false ? null : pick(embedding.startImages, choice.startImageId);
  const end = embedding.endEnabled === false ? null : pick(embedding.endImages, choice.endImageId);
  const drawn =
    choice.endDurationSeconds ??
    (embedding.finalDurationMode === 'custom'
      ? embedding.customFinalDurationSeconds
      : randomFinalImageDurationSeconds(embedding.finalDurationMode, random));

  return {
    startImageId: start?.id ?? null,
    endImageId: end?.id ?? null,
    fitMode: embedding.fitMode,
    endDurationSeconds: clampStitchEndDuration(drawn),
    startDurationSeconds:
      embedding.startDurationMode === 'one-frame'
        ? null
        : startImageDurationSeconds(
            {
              startDurationMode: embedding.startDurationMode,
              customStartDurationMs: embedding.customStartDurationMs
            },
            30
          )
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}
