/**
 * Building one static screen as a segment the join can copy.
 *
 * Three cheap steps rather than one clever one: encode the picture, cut the silence, mux
 * them. Keeping them separate is what lets the silence be a stream copy at all, and what
 * makes each step's cost visible in the timings.
 */

import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type {
  ImageFitMode,
  SourceProfile,
  StitchScreenSegmentPlan
} from '@video-compressor/shared';
import { buildHeldPicture, type HeldStep } from '../ffmpeg/held-picture.js';
import { ffmpegPath, ffprobePath } from '../ffmpeg/tools.js';
import {
  buildScreenHoldArgs,
  buildScreenStillArgs,
  buildScreenVideoArgs,
  buildSegmentMuxArgs,
  buildSilenceSliceArgs,
  isStitchArgumentError
} from '../ffmpeg/stitch-presets.js';
import { imageOrientation } from './exif.js';
import { runTool, toolSucceeded, type ToolResult } from './run.js';

export interface ScreenSegmentOptions {
  imagePath: string;
  profile: SourceProfile;
  screen: StitchScreenSegmentPlan;
  fitMode: ImageFitMode;
  /** A `mkdtemp` directory owned by the caller, removed by the caller. */
  workDir: string;
  /** Name stem, so a start and an end screen never collide inside one working directory. */
  name: string;
  silenceBankPath: string | null;
  threads?: number | null;
  signal?: AbortSignal;
  onChild?: (child: ChildProcess) => void;
}

export type SegmentResult = { ok: true; path: string } | { ok: false; error: string };

export async function buildScreenSegment(options: ScreenSegmentOptions): Promise<SegmentResult> {
  const videoPath = path.join(options.workDir, `${options.name}-v.mp4`);
  const audioPath = path.join(options.workDir, `${options.name}-a.aac`);
  const output = path.join(options.workDir, `${options.name}.mp4`);

  const videoOptions = {
    imagePath: options.imagePath,
    output: videoPath,
    profile: options.profile,
    screen: options.screen,
    fitMode: options.fitMode,
    threads: options.threads,
    orientation: await imageOrientation(options.imagePath)
  };
  try {
    buildScreenVideoArgs(videoOptions);
  } catch (error) {
    // A screen the builders refuse is a planning mistake, not a media failure; it must never
    // reach FFmpeg, because the shape they refuse is the one that hangs it.
    return { ok: false, error: isStitchArgumentError(error) ? error.message : 'SCREEN_INVALID' };
  }

  const run = { signal: options.signal, onChild: options.onChild };
  const last: { failure: ToolResult | null } = { failure: null };
  const stepOf = (result: ToolResult): HeldStep => {
    if (result.cancelled) return 'cancelled';
    if (toolSucceeded(result)) return 'ok';
    last.failure = result;
    return 'failed';
  };

  /*
   * A held screen is fitted once and that one frame is looped (see `buildScreenStillArgs`).
   * If the shorter road fails for any reason other than a cancellation, the original single
   * encode runs: the two-step path may only ever save time, never cost a screen.
   */
  const framePath = path.join(options.workDir, `${options.name}-v-frame.raw`);
  let fitted = false;
  if (options.screen.frames > 2) {
    const still = await runTool(
      ffmpegPath,
      buildScreenStillArgs({ ...videoOptions, frameOutput: framePath }),
      run
    ).catch(() => null);
    if (still?.cancelled) return { ok: false, error: 'STITCH_CANCELLED' };
    fitted = still !== null && toolSucceeded(still);
  }

  /** `frames` pictures of this screen, encoded with the screen's own arguments. */
  const encode = async (frames: number, output: string): Promise<HeldStep> => {
    const planned = {
      ...videoOptions,
      output,
      screen:
        frames === options.screen.frames
          ? options.screen
          : {
              ...options.screen,
              frames,
              durationSeconds: frames / options.screen.frameRate,
              aacFrames: 0
            }
    };
    if (fitted) {
      const hold = stepOf(
        await runTool(ffmpegPath, buildScreenHoldArgs({ ...planned, framePath }), run)
      );
      if (hold !== 'failed') return hold;
    }
    return stepOf(await runTool(ffmpegPath, buildScreenVideoArgs(planned), run));
  };

  /*
   * The picture at the body's rate for as long as the screen lasts. A long screen is not
   * encoded frame by frame: `buildHeldPicture` encodes a short seed and assembles the rest
   * from it by stream copy, and falls back to `encode` for the whole length if anything
   * about the seed is not what it measures for.
   */
  let built: Awaited<ReturnType<typeof buildHeldPicture>>;
  try {
    built = await buildHeldPicture({
      frames: options.screen.frames,
      frameRate: options.screen.frameRate,
      timescale: options.profile.videoTimescale,
      workDir: options.workDir,
      name: `${options.name}-held`,
      output: videoPath,
      encode,
      runner: {
        ffmpeg: async args => stepOf(await runTool(ffmpegPath, args, run)),
        ffprobe: async args => {
          const probed = await runTool(ffprobePath, args, { signal: options.signal });
          return toolSucceeded(probed) ? probed.stdout : null;
        }
      }
    });
  } finally {
    await rm(framePath, { force: true }).catch(() => undefined);
  }
  if (built.step === 'cancelled') return { ok: false, error: 'STITCH_CANCELLED' };
  if (built.step !== 'ok')
    return {
      ok: false,
      error: last.failure ? failureOf(last.failure, 'SCREEN_ENCODE') : 'SCREEN_ENCODE_FAILED'
    };

  const wantsSilence = options.screen.aacFrames > 0 && options.silenceBankPath;
  if (wantsSilence && options.silenceBankPath) {
    const silence = await runTool(
      ffmpegPath,
      buildSilenceSliceArgs({
        bankPath: options.silenceBankPath,
        aacFrames: options.screen.aacFrames,
        output: audioPath
      }),
      { signal: options.signal, onChild: options.onChild }
    );
    if (!toolSucceeded(silence)) return { ok: false, error: failureOf(silence, 'SCREEN_SILENCE') };
  }

  const muxed = await runTool(
    ffmpegPath,
    buildSegmentMuxArgs({
      videoPath,
      audioPath: wantsSilence ? audioPath : null,
      output,
      videoTimescale: options.profile.videoTimescale
    }),
    { signal: options.signal, onChild: options.onChild }
  );
  if (!toolSucceeded(muxed)) return { ok: false, error: failureOf(muxed, 'SCREEN_MUX') };

  return { ok: true, path: output };
}

function failureOf(result: { spawnErrorCode: string | null; cancelled: boolean }, stage: string) {
  if (result.cancelled) return 'STITCH_CANCELLED';
  return result.spawnErrorCode ? 'MEDIA_TOOL_UNAVAILABLE' : `${stage}_FAILED`;
}
