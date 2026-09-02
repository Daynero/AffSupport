/**
 * Building one static screen as a segment the join can copy.
 *
 * Three cheap steps rather than one clever one: encode the picture, cut the silence, mux
 * them. Keeping them separate is what lets the silence be a stream copy at all, and what
 * makes each step's cost visible in the timings.
 */

import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type {
  ImageFitMode,
  SourceProfile,
  StitchScreenSegmentPlan
} from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import {
  buildScreenVideoArgs,
  buildSegmentMuxArgs,
  buildSilenceSliceArgs,
  isStitchArgumentError
} from '../ffmpeg/stitch-presets.js';
import { runTool, toolSucceeded } from './run.js';

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

  let videoArgs: string[];
  try {
    videoArgs = buildScreenVideoArgs({
      imagePath: options.imagePath,
      output: videoPath,
      profile: options.profile,
      screen: options.screen,
      fitMode: options.fitMode,
      threads: options.threads
    });
  } catch (error) {
    // A screen the builders refuse is a planning mistake, not a media failure; it must never
    // reach FFmpeg, because the shape they refuse is the one that hangs it.
    return { ok: false, error: isStitchArgumentError(error) ? error.message : 'SCREEN_INVALID' };
  }

  const picture = await runTool(ffmpegPath, videoArgs, {
    signal: options.signal,
    onChild: options.onChild
  });
  if (!toolSucceeded(picture)) return { ok: false, error: failureOf(picture, 'SCREEN_ENCODE') };

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
