/**
 * The prepared body, kept between runs.
 *
 * This is the whole reason the second photo against a video costs ~0.6 s where the first
 * costs ~2.3 s, and it is deliberately invisible: there is no "prepare" button, no artifact
 * the user has to look after, and a cache miss is never an error — it only costs the
 * preparation again.
 *
 * Preparing means copying the body's streams out with their timestamps zeroed. Where the cut
 * point is not on a keyframe — which is the normal case for creatives made before this tool
 * existed — the stretch from the cut to the next keyframe is rebuilt and the rest copied,
 * because a stream copy cannot begin mid-GOP.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { SourceProfile, StitchPlan } from '@video-compressor/shared';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import {
  buildBodyRemuxArgs,
  buildConcatArgs,
  buildHeadReencodeArgs,
  concatListContents
} from '../ffmpeg/stitch-presets.js';
import { audioShapeDisagreements, measureAudioShape } from './audio-shape.js';
import { runTool, toolSucceeded } from './run.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Bumped whenever how a body is produced changes.
 *
 * Without it the cache is keyed only on the source, so a build that fixes how bodies are cut
 * happily serves the ones the previous build got wrong — which is exactly what happened when
 * the seek-length fix landed and the verification kept failing against a stale body.
 */
// 4: the body's audio is AAC-LC now, so a cached v3 body may carry HE-AAC that no player
//    can read once the silence is joined to it.
// 5: and so is the re-encoded head's, which v4 still copied — a body cut off a keyframe
//    carried both configurations at once and went silent at the seam.
const PREPARED_BODY_FORMAT = 5;

export interface PreparedBody {
  path: string;
  headWasReencoded: boolean;
  fromCache: boolean;
}

export type PrepareResult = { ok: true; value: PreparedBody } | { ok: false; error: string };

export interface PrepareOptions {
  profile: SourceProfile;
  plan: StitchPlan;
  threads?: number | null;
  signal?: AbortSignal;
  onChild?: (child: ChildProcess) => void;
}

/**
 * Identity, not just a path: a file edited in place under the same name must miss the cache.
 */
export function preparedBodyKey(profile: SourceProfile, plan: StitchPlan): string {
  return createHash('sha256')
    .update(
      [
        `v${PREPARED_BODY_FORMAT}`,
        path.resolve(profile.path),
        profile.sizeBytes,
        Math.round(profile.modifiedAtMs),
        plan.bodyStartSeconds.toFixed(6),
        plan.bodyEndSeconds.toFixed(6)
      ].join('|')
    )
    .digest('hex')
    .slice(0, 32);
}

export class PreparedBodyCache {
  private readonly directory: string;
  private readonly maxBytes: number;

  constructor(options: { root?: string; maxBytes?: number } = {}) {
    this.directory = path.join(options.root ?? applicationSupportRoot(), 'stitcher', 'bodies');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  pathFor(profile: SourceProfile, plan: StitchPlan): string {
    return path.join(this.directory, `${preparedBodyKey(profile, plan)}.mp4`);
  }

  async prepare(options: PrepareOptions): Promise<PrepareResult> {
    const target = this.pathFor(options.profile, options.plan);
    try {
      const stats = await stat(target);
      if (stats.size > 0) {
        // Touched so the least recently *used* body is the one evicted, not the oldest one.
        const now = new Date();
        await utimes(target, now, now).catch(() => {});
        return { ok: true, value: { path: target, headWasReencoded: false, fromCache: true } };
      }
    } catch {
      // Not prepared yet.
    }

    await mkdir(this.directory, { recursive: true });
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'soty-stitch-body-'));
    try {
      const built = await buildBody(workDir, options);
      if (!built.ok) return built;
      await rename(built.value.path, target);
      await this.evictDownToCap();
      return {
        ok: true,
        value: { path: target, headWasReencoded: built.value.headWasReencoded, fromCache: false }
      };
    } catch {
      return { ok: false, error: 'BODY_PREPARE_FAILED' };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Oldest-used first, until the directory fits its ceiling again. */
  private async evictDownToCap(): Promise<void> {
    let entries: { path: string; size: number; usedAtMs: number }[];
    try {
      const names = await readdir(this.directory);
      entries = await Promise.all(
        names.map(async name => {
          const full = path.join(this.directory, name);
          const stats = await stat(full);
          return { path: full, size: stats.size, usedAtMs: stats.mtimeMs };
        })
      );
    } catch {
      return;
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.maxBytes) return;
    for (const entry of entries.sort((a, b) => a.usedAtMs - b.usedAtMs)) {
      if (total <= this.maxBytes) return;
      await rm(entry.path, { force: true }).catch(() => {});
      total -= entry.size;
    }
  }
}

async function buildBody(
  workDir: string,
  options: PrepareOptions
): Promise<
  { ok: true; value: { path: string; headWasReencoded: boolean } } | { ok: false; error: string }
> {
  const { plan, profile } = options;
  const run = { signal: options.signal, onChild: options.onChild };

  if (plan.headReencodeUntilSeconds === null) {
    const output = path.join(workDir, 'body.mp4');
    const remux = await runTool(
      ffmpegPath,
      buildBodyRemuxArgs({
        input: profile.path,
        output,
        startSeconds: plan.bodyStartSeconds,
        endSeconds: plan.bodyEndSeconds,
        videoTimescale: profile.videoTimescale,
        frameRate: profile.frameRate,
        audioBitrateKbps: profile.audioBitrateKbps
      }),
      run
    );
    if (!toolSucceeded(remux)) return { ok: false, error: failureOf(remux, 'BODY_REMUX') };
    return { ok: true, value: { path: output, headWasReencoded: false } };
  }

  // The bounded exception: rebuild from the cut point to the next keyframe, copy the rest.
  const headEnd = Math.min(plan.headReencodeUntilSeconds, plan.bodyEndSeconds);
  const headPath = path.join(workDir, 'head.mp4');
  const head = await runTool(
    ffmpegPath,
    buildHeadReencodeArgs({
      input: profile.path,
      output: headPath,
      startSeconds: plan.bodyStartSeconds,
      endSeconds: headEnd,
      profile,
      threads: options.threads
    }),
    run
  );
  if (!toolSucceeded(head)) return { ok: false, error: failureOf(head, 'BODY_HEAD') };

  if (headEnd >= plan.bodyEndSeconds - 1e-6)
    return { ok: true, value: { path: headPath, headWasReencoded: true } };

  const tailPath = path.join(workDir, 'tail.mp4');
  const tail = await runTool(
    ffmpegPath,
    buildBodyRemuxArgs({
      input: profile.path,
      output: tailPath,
      startSeconds: headEnd,
      endSeconds: plan.bodyEndSeconds,
      videoTimescale: profile.videoTimescale,
      frameRate: profile.frameRate,
      audioBitrateKbps: profile.audioBitrateKbps
    }),
    run
  );
  if (!toolSucceeded(tail)) return { ok: false, error: failureOf(tail, 'BODY_TAIL') };

  // The same check the finished film gets, for the same reason: these two halves are copied
  // into one track with one sample description, and a rebuilt head that disagreed with the
  // copied tail about its AAC configuration would be a body no player could hear past the seam.
  const shapes = await Promise.all([
    measureAudioShape(headPath, run),
    measureAudioShape(tailPath, run)
  ]);
  if (audioShapeDisagreements(shapes).length > 0)
    return { ok: false, error: 'BODY_AUDIO_MISMATCH' };

  const listPath = path.join(workDir, 'body.txt');
  await writeFile(listPath, concatListContents([headPath, tailPath]), 'utf8');
  const output = path.join(workDir, 'body.mp4');
  const joined = await runTool(ffmpegPath, buildConcatArgs({ listPath, output }), run);
  if (!toolSucceeded(joined)) return { ok: false, error: failureOf(joined, 'BODY_JOIN') };
  return { ok: true, value: { path: output, headWasReencoded: true } };
}

function failureOf(result: { spawnErrorCode: string | null; cancelled: boolean }, stage: string) {
  if (result.cancelled) return 'STITCH_CANCELLED';
  return result.spawnErrorCode ? 'MEDIA_TOOL_UNAVAILABLE' : `${stage}_FAILED`;
}
