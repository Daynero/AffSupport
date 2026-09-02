/**
 * The Video Stitcher contract (feature 014).
 *
 * The stitcher replaces, adds, or removes the static photo screens at the edges of a video
 * without re-encoding the video itself. Everything here is shared on purpose: the web app
 * computes the preview it shows the user from `planStitch`, and the agent runs from the
 * same function, so the promise on screen and the file on disk can never come from two
 * different pieces of arithmetic.
 *
 * Only `import type` reaches `./types.js`. That module re-exports this one, so a value
 * import would close a runtime cycle for no benefit — the one value the plan needs from the
 * compressor's world (a resolved end-screen duration) is passed in already resolved.
 */

import type { ImageFitMode } from './types.js';

export type StitchOperation = 'stitch' | 'restitch' | 'unstitch';

/**
 * The compressor's own shape: a file added to the queue is `ready` until someone starts it.
 *
 * That is what makes the list a queue rather than a log — rows exist before they run, they
 * can be selected, and starting is an act on a selection.
 */
export type StitchStatus = 'ready' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Why a source cannot be served by the fast path (FR-023). Never a sentence. */
export type StitchUnsupportedReason =
  'video-codec' | 'audio-codec' | 'variable-frame-rate' | 'container' | 'unreadable';

export type StitchPlanFailure = StitchUnsupportedReason | 'nothing-to-remove' | 'no-screens';

export type StitchDestination =
  { kind: 'beside' } | { kind: 'folder'; path: string } | { kind: 'overwrite' };

/**
 * `inspecting` is first, and it is the reason it exists.
 *
 * Reading the source and finding its existing screens costs several seconds on a long file,
 * and it used to happen when the file was added — so dropping a video meant waiting before it
 * even appeared in the list. It is work a run needs, not work an entry needs, so it belongs
 * here.
 */
export type StitchStage = 'inspecting' | 'preparing' | 'screens' | 'joining' | 'verifying';

/**
 * What the source video actually is.
 *
 * Every screen is rendered to these numbers rather than to a house standard: the segments
 * being joined must agree on codec, size, pixel format, colour range, audio parameters and
 * timescale, and the only way to guarantee that for an arbitrary source is to copy its own.
 */
export interface SourceProfile {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
  container: string;
  videoCodec: string;
  profile: string | null;
  level: number | null;
  width: number;
  height: number;
  pixelFormat: string;
  colorRange: 'tv' | 'pc' | 'unknown';
  frameRate: number;
  variableFrameRate: boolean;
  videoTimescale: number;
  durationSeconds: number;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioBitrateKbps: number | null;
  /** Presentation times of every keyframe, ascending. Drives the head decision (D6). */
  keyframeTimes: number[];
}

/** The leading and trailing static runs found in the source. */
export interface DetectedStitching {
  startSeconds: number;
  endSeconds: number;
  adjustedByUser: boolean;
}

/**
 * The user's screen choices, with the end duration already resolved.
 *
 * Resolved rather than a mode, so a random range is drawn once — at the moment the job is
 * created — and the number the user was shown is the number that is produced.
 */
export interface StitchScreens {
  startImageId: string | null;
  endImageId: string | null;
  fitMode: ImageFitMode;
  endDurationSeconds: number;
  /** Held for one frame unless the user asked for longer; see D3 for why never one sample. */
  startDurationSeconds: number | null;
}

export interface StitchScreenSegmentPlan {
  /** How many encoded pictures the segment holds. The end screen is 1 fps (D2). */
  frames: number;
  frameRate: number;
  durationSeconds: number;
  /** Whole AAC frames, so the segment's audio and video durations are equal (D4). */
  aacFrames: number;
}

export interface StitchPlan {
  operation: StitchOperation;
  bodyStartSeconds: number;
  bodyEndSeconds: number;
  /** Null when the body already starts on a keyframe; otherwise the next keyframe (D6). */
  headReencodeUntilSeconds: number | null;
  startScreen: StitchScreenSegmentPlan | null;
  endScreen: StitchScreenSegmentPlan | null;
  promisedDurationSeconds: number;
  promisedFrameCount: number;
}

export interface StitchVerification {
  durationSeconds: number;
  frameCount: number;
  videoTrackSeconds: number;
  audioTrackSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  pixelFormat: string;
  withinTolerance: boolean;
  /** Named mismatches, for the log and the failure message. Empty when it passed. */
  mismatches: string[];
}

/**
 * What the card shows on each side: the source as it was, the result as it is.
 *
 * The same six facts the compressor's card carries, so the two panels line up column for
 * column — a person moving between the tools reads one layout, not two.
 */
export interface StitchMeasurements {
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
}

export interface StitchJob {
  id: string;
  sourcePath: string;
  sourceName: string;
  /** The source's own figures, so the row can show "before" without probing again. */
  source: StitchMeasurements;
  /** Filled in once the file exists and has been verified. */
  result: StitchMeasurements | null;
  /** What the edges look like. Found by the run, so a row that has not run yet has none. */
  detected: DetectedStitching | null;
  /** Decided when the run starts, so a setting changed meanwhile still applies. */
  plan: StitchPlan | null;
  operation: StitchOperation;
  destination: StitchDestination;
  outputSuffix: string;
  status: StitchStatus;
  stage: StitchStage | null;
  outputPath: string | null;
  elapsedMs: number | null;
  error: string | null;
  verification: StitchVerification | null;
  createdAt: string;
}

/**
 * The stitcher's own settings are only about the file it writes.
 *
 * Everything about the screens — which photos, which fit mode, how long the final one is
 * held — is the compressor's `imageEmbedding` settings, read live. One library, one set of
 * controls, one place to change them; a second copy would drift within a week.
 */
export interface StitchSettings {
  destination: StitchDestination;
  outputSuffix: string;
}

export interface StitcherState {
  settings: StitchSettings;
  jobs: StitchJob[];
  busy: boolean;
}

export type StitcherEventType = 'stitcher:state';

/** The live-state event, in the same shape every other tool publishes. */
export interface StitcherEvent {
  type: StitcherEventType;
  state: StitcherState;
}

export type StitchSettingsPatch = Partial<StitchSettings>;

export const STITCH_END_DURATION_MIN_SECONDS = 1;
/** The compressor's own ceiling: its final image is held for up to an hour. */
export const STITCH_END_DURATION_MAX_SECONDS = 60 * 60;
export const DEFAULT_STITCH_END_DURATION_SECONDS = 45 * 60;

/** One AAC frame is 1024 samples; every screen duration is a whole number of them (D4). */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * A screen is capped at this many pictures, however long it is held.
 *
 * The cost of a screen is its **frame count**, not its duration, and the compressor's final
 * image runs to an hour. Measured at 1080×1080: a 45-minute screen at one picture per second
 * is 2700 frames and **18.3 seconds** of encoding — the five-second promise gone. The same
 * screen at 300 pictures (one every nine seconds) takes 1.4 s, and a 45-second screen still
 * gets its full one-per-second. A single frame would be faster still (0.17 s) but nothing can
 * seek inside it, which breaks thumbnails and scrubbing. See research D2 and D17.
 */
export const STITCH_MAX_SCREEN_FRAMES = 300;

/** Never more than one picture a second, and never more than the cap. */
export const STITCH_MAX_SCREEN_FPS = 1;

/**
 * A screen segment never holds a single sample.
 *
 * A one-sample MP4 video track has no sample-to-sample delta, the muxer writes its duration
 * as one tick, and the concat demuxer then places the next segment on top of it — the screen
 * measurably disappears. Two samples make the duration explicit. See research D3.
 */
export const STITCH_MIN_SCREEN_FRAMES = 2;

/**
 * How often a held screen gets a picture.
 *
 * One a second for anything short enough that the cap is not reached; fewer, evenly spread,
 * for the long screens the compressor's ranges produce. Below two seconds the body's own frame
 * rate is used, because a screen still needs two samples to carry its duration through the
 * join (D3) and thirty near-empty frames cost nothing.
 */
export function endScreenFrameRate(durationSeconds: number, bodyFrameRate: number): number {
  if (!(durationSeconds > 0)) return bodyFrameRate;
  if (durationSeconds < STITCH_MIN_SCREEN_FRAMES / STITCH_MAX_SCREEN_FPS) return bodyFrameRate;
  const capped = STITCH_MAX_SCREEN_FRAMES / durationSeconds;
  return Math.min(STITCH_MAX_SCREEN_FPS, capped);
}

export function clampStitchEndDuration(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_STITCH_END_DURATION_SECONDS;
  return Math.min(
    STITCH_END_DURATION_MAX_SECONDS,
    Math.max(STITCH_END_DURATION_MIN_SECONDS, number)
  );
}

export function defaultStitchSettings(): StitchSettings {
  return { destination: { kind: 'beside' }, outputSuffix: '' };
}

/**
 * Rounds a duration to whole AAC frames, never below one.
 *
 * Cutting silence with `-t D` returns the frame that *covers* D, so the audio comes out
 * longer than the video and the segments drift apart at every seam. Snapping the requested
 * duration first, then cutting exactly that many frames, makes the two tracks equal by
 * construction (D4).
 */
export function snapToAacFrames(
  seconds: number,
  sampleRate: number
): { aacFrames: number; seconds: number } {
  if (!Number.isFinite(seconds) || !Number.isFinite(sampleRate) || sampleRate <= 0)
    return { aacFrames: 0, seconds: Math.max(0, Number.isFinite(seconds) ? seconds : 0) };
  const frames = Math.max(1, Math.round((seconds * sampleRate) / AAC_FRAME_SAMPLES));
  return { aacFrames: frames, seconds: (frames * AAC_FRAME_SAMPLES) / sampleRate };
}

/** True when `time` lands on one of the source's keyframes, within half a frame. */
export function isOnKeyframe(profile: SourceProfile, time: number): boolean {
  if (time <= 0) return true;
  const tolerance = profile.frameRate > 0 ? 0.5 / profile.frameRate : 0.001;
  return profile.keyframeTimes.some(candidate => Math.abs(candidate - time) <= tolerance);
}

/** The first keyframe strictly after `time`, or null when the source has none left. */
export function nextKeyframeAfter(profile: SourceProfile, time: number): number | null {
  const tolerance = profile.frameRate > 0 ? 0.5 / profile.frameRate : 0.001;
  return profile.keyframeTimes.find(candidate => candidate > time + tolerance) ?? null;
}

/**
 * Whether the source can be stitched without re-encoding its body.
 *
 * Returns the specific reason rather than a boolean: the user is told which property of
 * their file made it unsuitable, and the interface turns the code into one sentence.
 */
export function stitchUnsupportedReason(profile: SourceProfile): StitchUnsupportedReason | null {
  if (!profile.container.includes('mp4') && !profile.container.includes('mov')) return 'container';
  if (profile.videoCodec !== 'h264') return 'video-codec';
  if (profile.hasAudio && profile.audioCodec !== 'aac') return 'audio-codec';
  if (profile.variableFrameRate) return 'variable-frame-rate';
  if (!(profile.width > 0) || !(profile.height > 0) || !(profile.frameRate > 0))
    return 'unreadable';
  if (!(profile.durationSeconds > 0)) return 'unreadable';
  return null;
}

/**
 * Whole video frames decide the screen's length; the silence is the nearest whole AAC frame.
 *
 * One of the two has to be authoritative, because a video frame (1/30 s at 48 kHz is 1600
 * samples) and an AAC frame (1024 samples) only line up exactly every 0.53 s — a start
 * screen snapped to that would be half a second long and plainly visible, when what the
 * compressor has always produced is a single frame. Video wins, so the picture is exactly as
 * long as it claims, and the silence lands within one AAC frame (≤ 21 ms) of it, which is
 * inside the verification tolerance rather than the drift D4 was written to remove.
 */
export function screenSegmentPlan(
  durationSeconds: number,
  frameRate: number,
  profile: SourceProfile
): StitchScreenSegmentPlan {
  const frames = Math.max(
    STITCH_MIN_SCREEN_FRAMES,
    Math.round(Math.max(0, durationSeconds) * frameRate)
  );
  const seconds = frames / frameRate;
  const sampleRate = profile.hasAudio ? (profile.audioSampleRate ?? 48000) : 0;
  return {
    frames,
    frameRate,
    durationSeconds: seconds,
    aacFrames: sampleRate ? snapToAacFrames(seconds, sampleRate).aacFrames : 0
  };
}

/** A body shorter than this is not a body, whatever the detector thinks it found. */
export const STITCH_MIN_BODY_SECONDS = 1;

/** …and neither is one that is a rounding error next to the source. */
export const STITCH_MIN_BODY_SHARE = 0.02;

/**
 * Refuses a detection that would swallow the video.
 *
 * The edge detector looks for runs of visually identical frames, and some real footage —
 * a slow pan, a held product shot, a test pattern — reads as identical at the sampling
 * resolution it uses. Left unchecked that produced a "creative" consisting of a
 * forty-five-second photo and one frame of video, and the verification passed it, because
 * the plan and the output agreed with each other about the same wrong thing.
 *
 * So the plan applies the one rule the detector cannot: whatever was found at the edges, a
 * body has to remain. When it does not, nothing was found — the file is stitched rather
 * than re-stitched, and a request to remove screens is answered honestly.
 */
export function believableDetection(
  profile: SourceProfile,
  detected: DetectedStitching
): DetectedStitching {
  // A boundary the user moved themselves is theirs to choose.
  if (detected.adjustedByUser) return detected;
  const floor = Math.max(STITCH_MIN_BODY_SECONDS, profile.durationSeconds * STITCH_MIN_BODY_SHARE);
  const body = profile.durationSeconds - detected.startSeconds - detected.endSeconds;
  if (body >= floor) return detected;
  return { startSeconds: 0, endSeconds: 0, adjustedByUser: false };
}

/**
 * Turns what was found and what was asked for into the one object that is both the promise
 * and, after the run, the thing the finished file is checked against.
 *
 * Pure and total. The operation is inferred from the detected edges rather than asked
 * (FR-027); only removal is requested explicitly, and asking for it where there is nothing
 * to remove is a named failure rather than an empty file (FR-008).
 */
export function planStitch(
  profile: SourceProfile,
  detected: DetectedStitching,
  screens: StitchScreens,
  operation?: StitchOperation
): { ok: true; value: StitchPlan } | { ok: false; error: StitchPlanFailure } {
  const unsupported = stitchUnsupportedReason(profile);
  if (unsupported) return { ok: false, error: unsupported };

  const believable = believableDetection(profile, detected);
  const hasExisting = believable.startSeconds > 0 || believable.endSeconds > 0;
  const requested: StitchOperation = operation ?? (hasExisting ? 'restitch' : 'stitch');
  if (requested === 'unstitch' && !hasExisting) return { ok: false, error: 'nothing-to-remove' };

  const removing = requested === 'unstitch';
  const startScreen =
    !removing && screens.startImageId
      ? screenSegmentPlan(
          screens.startDurationSeconds ?? STITCH_MIN_SCREEN_FRAMES / profile.frameRate,
          profile.frameRate,
          profile
        )
      : null;
  const endSeconds = clampStitchEndDuration(screens.endDurationSeconds);
  const endFrameRate = endScreenFrameRate(endSeconds, profile.frameRate);
  const endScreen =
    !removing && screens.endImageId ? screenSegmentPlan(endSeconds, endFrameRate, profile) : null;
  if (!removing && !startScreen && !endScreen) return { ok: false, error: 'no-screens' };

  // Only an existing screen is cut away. A `stitch` never trims the source, and a
  // `restitch` trims exactly what was detected (or what the user moved it to).
  const bodyStartSeconds = requested === 'stitch' ? 0 : believable.startSeconds;
  const bodyEndSeconds =
    requested === 'stitch'
      ? profile.durationSeconds
      : Math.max(bodyStartSeconds, profile.durationSeconds - believable.endSeconds);

  const headReencodeUntilSeconds = isOnKeyframe(profile, bodyStartSeconds)
    ? null
    : (nextKeyframeAfter(profile, bodyStartSeconds) ?? bodyEndSeconds);

  const bodySeconds = Math.max(0, bodyEndSeconds - bodyStartSeconds);
  const promisedDurationSeconds =
    bodySeconds + (startScreen?.durationSeconds ?? 0) + (endScreen?.durationSeconds ?? 0);
  const promisedFrameCount =
    Math.round(bodySeconds * profile.frameRate) +
    (startScreen?.frames ?? 0) +
    (endScreen?.frames ?? 0);

  return {
    ok: true,
    value: {
      operation: requested,
      bodyStartSeconds,
      bodyEndSeconds,
      headReencodeUntilSeconds,
      startScreen,
      endScreen,
      promisedDurationSeconds,
      promisedFrameCount
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrows an untrusted payload into a `SourceProfile`.
 *
 * Everything that crosses a process boundary arrives as `unknown` and leaves as a
 * discriminated result — `ffprobe` output included, which is the payload this exists for.
 */
export function parseSourceProfile(
  value: unknown
): { ok: true; value: SourceProfile } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'SOURCE_PROFILE_INVALID' };
  const path = typeof value.path === 'string' && value.path ? value.path : null;
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const frameRate = finiteNumber(value.frameRate);
  const durationSeconds = finiteNumber(value.durationSeconds);
  if (!path || width === null || height === null || frameRate === null || durationSeconds === null)
    return { ok: false, error: 'SOURCE_PROFILE_INCOMPLETE' };
  const colorRange = value.colorRange;
  const keyframes = Array.isArray(value.keyframeTimes)
    ? value.keyframeTimes.filter((time): time is number => finiteNumber(time) !== null)
    : [];
  return {
    ok: true,
    value: {
      path,
      sizeBytes: finiteNumber(value.sizeBytes) ?? 0,
      modifiedAtMs: finiteNumber(value.modifiedAtMs) ?? 0,
      container: typeof value.container === 'string' ? value.container : '',
      videoCodec: typeof value.videoCodec === 'string' ? value.videoCodec : '',
      profile: typeof value.profile === 'string' ? value.profile : null,
      level: finiteNumber(value.level),
      width,
      height,
      pixelFormat: typeof value.pixelFormat === 'string' ? value.pixelFormat : 'yuv420p',
      colorRange: colorRange === 'tv' || colorRange === 'pc' ? colorRange : 'unknown',
      frameRate,
      variableFrameRate: value.variableFrameRate === true,
      videoTimescale: finiteNumber(value.videoTimescale) ?? Math.round(frameRate * 512),
      durationSeconds,
      hasAudio: value.hasAudio === true,
      audioCodec: typeof value.audioCodec === 'string' ? value.audioCodec : null,
      audioSampleRate: finiteNumber(value.audioSampleRate),
      audioChannels: finiteNumber(value.audioChannels),
      audioBitrateKbps: finiteNumber(value.audioBitrateKbps),
      keyframeTimes: [...keyframes].sort((a, b) => a - b)
    }
  };
}

function parseDestination(value: unknown): StitchDestination | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'beside') return { kind: 'beside' };
  if (value.kind === 'overwrite') return { kind: 'overwrite' };
  if (value.kind === 'folder' && typeof value.path === 'string' && value.path)
    return { kind: 'folder', path: value.path };
  return null;
}

/**
 * Browser-writable settings, validated the way the compressor validates its own patch.
 *
 * An unknown key is ignored rather than rejected; a known key with an unusable value fails,
 * because silently substituting a default for something the user asked for is worse than
 * saying no.
 */
export function parseStitchSettingsPatch(
  value: unknown
): { ok: true; value: StitchSettingsPatch } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'STITCH_SETTINGS_INVALID' };
  const patch: StitchSettingsPatch = {};
  if ('destination' in value) {
    const destination = parseDestination(value.destination);
    if (!destination) return { ok: false, error: 'STITCH_SETTINGS_INVALID' };
    patch.destination = destination;
  }
  if ('outputSuffix' in value) {
    if (typeof value.outputSuffix !== 'string' || value.outputSuffix.length > 64)
      return { ok: false, error: 'STITCH_SETTINGS_INVALID' };
    patch.outputSuffix = value.outputSuffix;
  }
  return { ok: true, value: patch };
}
