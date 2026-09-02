/**
 * How busy the machine's graphics processor is.
 *
 * The consumption readout used to measure only the CPU, and for years that was the whole
 * story. It stopped being so the moment speech recognition started running on the GPU: a
 * transcription that had the machine on its knees reported **0.4%**, because the process
 * genuinely was not using the CPU. A lever labelled "power" that reads nearly zero while the
 * fans are at full is worse than no reading at all — it tells the owner their setting is
 * working when it is measuring the wrong thing entirely.
 *
 * **This is the machine's figure, not Soty's.** macOS exposes no per-process graphics usage
 * without elevated privileges, so what is read here is the whole device's utilisation. The
 * caller pairs it with "is Soty running anything", and the interface says which number is
 * which, rather than presenting a system-wide reading as this application's own.
 *
 * Only Apple Silicon and Intel Macs answer. Elsewhere the reading is absent — and absent is
 * reported as absent, never as zero.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentPlatform } from '../platform/platform.js';

const run = promisify(execFile);

/** The driver publishes this in its performance statistics; the accelerator class holds it. */
const UTILIZATION = /"Device Utilization %"\s*=\s*(\d+)/u;
/** A stuck `ioreg` must not stall a reading that is taken once a second. */
const PROBE_TIMEOUT_MS = 2_000;

export function graphicsProbeSupported(): boolean {
  return currentPlatform() === 'darwin';
}

/**
 * The device's graphics utilisation, 0–100, or null when it cannot be read.
 *
 * Null covers every reason at once — the wrong platform, a driver that publishes no such
 * key, a probe that timed out — because they lead to the same honest answer: we do not know.
 */
export async function graphicsUtilizationPercent(): Promise<number | null> {
  if (!graphicsProbeSupported()) return null;
  try {
    const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
      timeout: PROBE_TIMEOUT_MS,
      // The listing carries the whole accelerator tree; the figure is near the top of it.
      maxBuffer: 4 * 1024 * 1024
    });
    return parseGraphicsUtilization(stdout);
  } catch {
    return null;
  }
}

/** Split out so the parsing is testable without a machine that has a GPU. */
export function parseGraphicsUtilization(listing: string): number | null {
  const matched = UTILIZATION.exec(listing);
  if (!matched) return null;
  const value = Number(matched[1]);
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}
