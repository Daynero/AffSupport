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
  request: StitchPipelineRequest;
  workDir: string;
  threads: number | null;
  signal: AbortSignal;
  onChild: (child: ChildProcess) => void;
  onStage: (stage: StitchStage) => void;
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

  const body = await context.bodies.prepare({ profile, plan, threads, ...run });
  if (!body.ok) return { ok: false, error: body.error };

  // What the body actually is, not what it was predicted to be: see `measureSegment`.
  const measuredBody = await measureSegment(body.value.path, { signal: context.signal });

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
   * Which of the body's two lengths applies depends on what is about to happen to it. Joined,
   * the concat demuxer advances the timeline by each part's container duration; left alone,
   * the finished file is the body and keeps the body's own video track. Both were tried
   * against the wrong case, and both failed a correct file.
   */
  const joining = segments.length > 1;
  const bodySeconds = measuredBody
    ? joining
      ? measuredBody.durationSeconds
      : measuredBody.videoTrackSeconds
    : 0;
  const expected: StitchPlan = measuredBody
    ? {
        ...plan,
        promisedDurationSeconds:
          bodySeconds +
          (plan.startScreen?.durationSeconds ?? 0) +
          (plan.endScreen?.durationSeconds ?? 0),
        promisedFrameCount:
          measuredBody.frameCount + (plan.startScreen?.frames ?? 0) + (plan.endScreen?.frames ?? 0)
      }
    : plan;

  context.onStage('joining');
  const staged = path.join(workDir, 'result.mp4');
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
        staged
      ],
      run
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
    await writeFile(listPath, concatListContents(segments), 'utf8');
    const joined = await runTool(ffmpegPath, buildConcatArgs({ listPath, output: staged }), run);
    if (!toolSucceeded(joined)) return { ok: false, error: failureOf(joined, 'STITCH_JOIN') };
  }

  context.onStage('verifying');
  const verification = await verifyOutput(staged, expected, profile, { signal: context.signal });
  if (!verification) return { ok: false, error: 'STITCH_VERIFICATION_FAILED' };
  if (!verification.withinTolerance)
    return { ok: false, error: 'STITCH_VERIFICATION_FAILED', verification };
  return { ok: true, stagedPath: staged, verification };
};

function failureOf(result: { spawnErrorCode: string | null; cancelled: boolean }, stage: string) {
  if (result.cancelled) return 'STITCH_CANCELLED';
  return result.spawnErrorCode ? 'MEDIA_TOOL_UNAVAILABLE' : `${stage}_FAILED`;
}
