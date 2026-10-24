/**
 * The media half of a run: prepared body, screens, join, verify.
 *
 * Separated from the queue because they answer different questions. The queue owns order,
 * cancellation and state; this owns what FFmpeg is asked to do. Injecting it is also what
 * makes the queue's own behaviour — one at a time, a failure that does not stop a batch,
 * a stop that leaves nothing behind — testable without a media engine, in the same way the
 * media-action queue takes its converter.
 */

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type {
  SourceProfile,
  StitchDestination,
  StitchPlan,
  StitchScreens,
  StitchStage,
  StitchVerification
} from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { buildConcatArgs, concatListContents } from '../ffmpeg/stitch-presets.js';
import { audioShapeDisagreements, measureAudioShape } from './audio-shape.js';
import { PreparedBodyCache } from './body-cache.js';
import { buildScreenSegment } from './segments.js';
import { ensureSilenceBank } from './silence.js';
import { runTool, toolSucceeded } from './run.js';
import { measureSegment, verifyOutput } from './verify.js';
import { diagnostics, durationBucket } from '../server/diagnostics-log.js';
/**
 * What the media half needs, which is a decided plan rather than a chosen row.
 *
 * Its own type on purpose: the queue's request is what the *user* asked for, and turning that
 * into a plan is the queue's inspecting stage. The pipeline never asks what the source looks
 * like — by the time it runs, that is settled.
 */
export interface StitchPipelineRequest {
  profile: SourceProfile;
  plan: StitchPlan;
  screens: StitchScreens;
  destination: StitchDestination;
  outputSuffix: string;
}

export interface PipelineContext {
  /** Queue job id, shared with the web run_id and local recovery journal. */
  runId?: string;
  request: StitchPipelineRequest;
  workDir: string;
  threads: number | null;
  signal: AbortSignal;
  onChild: (child: ChildProcess) => void;
  onStage: (stage: StitchStage) => void;
  /**
   * How far through the join, as a fraction, while it runs.
   *
   * The join is nearly the whole wall clock of a stitch, and the three stages alone left a
   * bar sitting at one number for a minute at a time. FFmpeg reports the output time it has
   * written; against the duration the plan promised, that is a real percentage.
   */
  onJoinProgress?: (fraction: number) => void;
  imagePathFor: (id: string) => Promise<string | null>;
  bodies: PreparedBodyCache;
}

export type PipelineResult =
  | { ok: true; stagedPath: string; verification: StitchVerification }
  | { ok: false; error: string; verification?: StitchVerification };

export type StitchPipeline = (context: PipelineContext) => Promise<PipelineResult>;

/**
 * Produces the finished file in the working directory and proves it.
 *
 * It never installs: moving the result into place — and, for an overwrite, replacing the
 * source — belongs to the queue, so the one irreversible step happens after this has
 * returned successfully and nowhere else.
 */
export const runStitchPipeline: StitchPipeline = async context => {
  const { request, workDir, threads } = context;
  const { profile, plan, screens } = request;
  const run = { signal: context.signal, onChild: context.onChild };
  type Phase = 'silence' | 'body' | 'measurement' | 'screens' | 'joining' | 'verification';
  let phase: Phase = 'silence';
  let phaseStartedAt = performance.now();
  const identity: Record<string, string> = context.runId ? { runId: context.runId } : {};
  const completedPhase = (props: { fromCache?: boolean } = {}) =>
    diagnostics.record('stitcher', 'pipeline_stage_completed', {
      ...identity,
      stage: phase,
      durationBucket: durationBucket(performance.now() - phaseStartedAt),
      ...props
    });
  const nextPhase = (next: Phase, props: { fromCache?: boolean } = {}) => {
    completedPhase(props);
    phase = next;
    phaseStartedAt = performance.now();
    diagnostics.record('stitcher', 'pipeline_stage_started', { ...identity, stage: phase });
  };
  diagnostics.record('stitcher', 'pipeline_stage_started', { ...identity, stage: phase });

  let silenceBankPath: string | null = null;
  if (profile.hasAudio && (plan.startScreen || plan.endScreen)) {
    const bank = await ensureSilenceBank({
      sampleRate: profile.audioSampleRate ?? 48000,
      channels: profile.audioChannels ?? 2,
      bitrateKbps: profile.audioBitrateKbps ?? 96,
      // The longest screen decides how long a bank this run needs.
      neededSeconds: Math.max(
        plan.startScreen?.durationSeconds ?? 0,
        plan.endScreen?.durationSeconds ?? 0
      ),
      signal: context.signal
    });
    if (!bank.ok) return { ok: false, error: bank.error };
    silenceBankPath = bank.path;
  }

  nextPhase('body');
  const body = await context.bodies.prepare({
    profile,
    plan,
    threads,
    runId: context.runId,
    ...run
  });
  if (!body.ok) return { ok: false, error: body.error };
  nextPhase('measurement', { fromCache: body.value.fromCache });

  // What the body actually is, not what it was predicted to be: see `measureSegment`.
  const measuredBody = await measureSegment(body.value.path, { signal: context.signal });
  // The verification probe already read every packet's presentation timestamp. Reuse
  // that measurement instead of scanning the same body again with another ffprobe.
  const bodyConcatSeconds = measuredBody?.concatDurationSeconds ?? null;
  // Segment measurements may correct muxing drift, but must never redefine a lost body
  // as the promised result. Check the video track before adopting measured durations.
  const plannedBodySeconds = plan.bodyEndSeconds - plan.bodyStartSeconds;
  const bodyToleranceSeconds = Math.max(0.25, 3 / profile.frameRate);
  if (
    !measuredBody ||
    bodyConcatSeconds === null ||
    Math.abs(measuredBody.videoTrackSeconds - plannedBodySeconds) > bodyToleranceSeconds
  ) {
    return { ok: false, error: 'STITCH_VERIFICATION_FAILED' };
  }

  nextPhase('screens');
  context.onStage('screens');
  const screen = async (
    plannedScreen: StitchPlan['startScreen'],
    imageId: string | null,
    name: 'intro' | 'outro'
  ) => {
    if (!plannedScreen || !imageId) return { ok: true as const, path: null };
    const imagePath = await context.imagePathFor(imageId);
    if (!imagePath) return { ok: false as const, error: 'STITCH_IMAGE_UNAVAILABLE' };
    return buildScreenSegment({
      imagePath,
      profile,
      screen: plannedScreen,
      fitMode: screens.fitMode,
      workDir,
      name,
      silenceBankPath,
      threads,
      ...run
    });
  };

  const intro = await screen(plan.startScreen, screens.startImageId, 'intro');
  if (!intro.ok) return intro;
  const outro = await screen(plan.endScreen, screens.endImageId, 'outro');
  if (!outro.ok) return outro;
  const segments = [intro.path, body.value.path, outro.path].filter(
    (segment): segment is string => segment !== null
  );

  /*
   * The promise, restated from the parts that actually exist.
   *
   * Before an outro, concat advances by the body's corrected container duration. With only
   * an intro, the body is last and concat removes its timestamp origin. The standalone
   * remux also removes that origin, including the positive origin of copied B-frames.
   * These are different measurements from the absolute end timestamp in the body file.
   */
  const joining = segments.length > 1;
  let bodySeconds = measuredBody.videoTrackSeconds - measuredBody.startTimeSeconds;
  if (joining) {
    bodySeconds = outro.path
      ? bodyConcatSeconds
      : measuredBody.videoTrackSeconds - measuredBody.startTimeSeconds;
  }
  const expected: StitchPlan = {
    ...plan,
    promisedDurationSeconds:
      bodySeconds +
      (plan.startScreen?.durationSeconds ?? 0) +
      (plan.endScreen?.durationSeconds ?? 0),
    promisedFrameCount:
      measuredBody.frameCount + (plan.startScreen?.frames ?? 0) + (plan.endScreen?.frames ?? 0)
  };

  nextPhase('joining');
  context.onStage('joining');
  const staged = path.join(workDir, 'result.mp4');
  /** Turns FFmpeg's `out_time_us` into a fraction of what the plan promised. */
  const joinProgress = (line: string) => {
    const matched = /^out_time_us=(\d+)$/u.exec(line);
    if (!matched || !context.onJoinProgress) return;
    const seconds = Number(matched[1]) / 1_000_000;
    const total = expected.promisedDurationSeconds;
    if (!(total > 0) || !Number.isFinite(seconds)) return;
    context.onJoinProgress(Math.max(0, Math.min(1, seconds / total)));
  };
  const joinRun = { ...run, onLine: joinProgress };
  if (segments.length === 1) {
    // Removing the stitching: the prepared body *is* the result. Copied out rather than
    // used in place, so the cached body is never the file that gets renamed away.
    const copy = await runTool(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        segments[0] as string,
        '-map',
        '0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        staged
      ],
      joinRun
    );
    if (!toolSucceeded(copy)) return { ok: false, error: failureOf(copy, 'STITCH_JOIN') };
  } else {
    /*
     * The parts have to agree about their sound before they are copied into one track.
     *
     * The concat demuxer writes a single sample description per track, taken from the first
     * input, and every later frame is decoded against it. A screen's AAC-LC silence in front
     * of an HE-AAC body therefore produces a file FFmpeg reads perfectly and CoreAudio — so
     * QuickTime, Safari, Telegram and Finder — refuses after the first seconds: a re-stitched
     * video with the picture right and no sound at all. It shipped once, because every check
     * we had was an FFmpeg check.
     */
    const shapes = await Promise.all(
      segments.map(segment => measureAudioShape(segment, { signal: context.signal }))
    );
    const disagreements = audioShapeDisagreements(shapes);
    if (disagreements.length > 0) return { ok: false, error: 'STITCH_AUDIO_MISMATCH' };

    const listPath = path.join(workDir, 'segments.txt');
    await writeFile(
      listPath,
      concatListContents(
        segments,
        segments.map(segment => (segment === body.value.path ? bodyConcatSeconds : null))
      ),
      'utf8'
    );
    const joined = await runTool(
      ffmpegPath,
      buildConcatArgs({ listPath, output: staged, progress: true }),
      joinRun
    );
    if (!toolSucceeded(joined)) return { ok: false, error: failureOf(joined, 'STITCH_JOIN') };
  }

  nextPhase('verification');
  context.onStage('verifying');
  const verification = await verifyOutput(staged, expected, profile, { signal: context.signal });
  if (!verification) return { ok: false, error: 'STITCH_VERIFICATION_FAILED' };
  if (!verification.withinTolerance)
    return { ok: false, error: 'STITCH_VERIFICATION_FAILED', verification };
  completedPhase();
  return { ok: true, stagedPath: staged, verification };
};

function failureOf(result: { spawnErrorCode: string | null; cancelled: boolean }, stage: string) {
  if (result.cancelled) return 'STITCH_CANCELLED';
  return result.spawnErrorCode ? 'MEDIA_TOOL_UNAVAILABLE' : `${stage}_FAILED`;
}
