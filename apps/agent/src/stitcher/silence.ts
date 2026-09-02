/**
 * Silence, once per audio shape.
 *
 * A screen's audio is always the same thing — nothing — so encoding it per run would be
 * paying repeatedly for a constant. One bank per (sample rate, channels) is built the first
 * time it is needed and then sliced by stream copy, which measured at ~30 ms against ~200 ms
 * to encode.
 */

import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from '../ffmpeg/tools.js';
import { applicationSupportRoot } from '../files/support-dir.js';
import { buildSilenceBankArgs } from '../ffmpeg/stitch-presets.js';
import { runTool, toolSucceeded } from './run.js';

/**
 * Comfortably past the longest end screen the compressor's settings allow (an hour).
 *
 * Silence compresses to almost nothing — an hour of it is under three megabytes — and the
 * bank is built once per audio shape, so the length costs a few seconds exactly once.
 */
const BANK_SECONDS = 60 * 60 + 60;
const DEFAULT_BITRATE_KBPS = 96;

export function silenceRoot(root = applicationSupportRoot()): string {
  return path.join(root, 'stitcher', 'silence');
}

/**
 * The bank's length is part of its name.
 *
 * A bank is only ever read, never inspected, so a shorter one left over from an earlier build
 * is used happily and every slice comes out truncated — which is exactly what happened when
 * the end screen grew from seconds to minutes: the picture ran 48 minutes and the silence 5.
 * Naming the length makes a longer bank a different file.
 */
export function silenceBankPath(
  sampleRate: number,
  channels: number,
  seconds: number,
  root = applicationSupportRoot()
): string {
  return path.join(
    silenceRoot(root),
    `silence-${sampleRate}-${channels}-${Math.ceil(seconds)}.aac`
  );
}

export interface SilenceBankOptions {
  sampleRate: number;
  channels: number;
  bitrateKbps?: number | null;
  /** The longest slice this bank has to serve. The bank is built to cover it with room. */
  neededSeconds?: number;
  root?: string;
  signal?: AbortSignal;
}

/**
 * Returns the bank's path, building it if this is the first time this shape is needed.
 *
 * Installed by staging into a temp directory and renaming, so a bank interrupted halfway
 * through cannot be found and used by the next run.
 */
export async function ensureSilenceBank(
  options: SilenceBankOptions
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const root = options.root ?? applicationSupportRoot();
  const seconds = Math.max(BANK_SECONDS, Math.ceil((options.neededSeconds ?? 0) * 1.05));
  const target = silenceBankPath(options.sampleRate, options.channels, seconds, root);
  try {
    const stats = await stat(target);
    if (stats.size > 0) return { ok: true, path: target };
  } catch {
    // Not built yet.
  }

  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(path.join(os.tmpdir(), 'soty-silence-'));
  try {
    const staged = path.join(staging, 'silence.aac');
    const result = await runTool(
      ffmpegPath,
      buildSilenceBankArgs({
        output: staged,
        sampleRate: options.sampleRate,
        channels: options.channels,
        bitrateKbps: options.bitrateKbps || DEFAULT_BITRATE_KBPS,
        seconds
      }),
      { signal: options.signal }
    );
    if (!toolSucceeded(result))
      return {
        ok: false,
        error: result.spawnErrorCode ? 'MEDIA_TOOL_UNAVAILABLE' : 'SILENCE_BANK_FAILED'
      };
    await rename(staged, target);
    return { ok: true, path: target };
  } catch {
    return { ok: false, error: 'SILENCE_BANK_FAILED' };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
