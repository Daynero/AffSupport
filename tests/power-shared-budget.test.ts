import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { spawnManaged } from '../apps/agent/src/power/spawn.js';
import { sampleMachine, type MachineSample } from './support/machine-probe.js';
import { writeStubTool } from './support/stub-tools/index.js';
import { describeRequiring, requireEnvFlag } from './support/requires.js';

/**
 * SC-004 / FR-010. One limit, shared: whatever combination of tools is running,
 * together they stay inside it. A per-tool budget would pass every single-tool
 * test and still hand the machine over as soon as two things ran at once, which
 * is the ordinary case — an encode while a transcription finishes.
 *
 * Measured with the machine probe rather than the governor's own readout. The
 * governor reporting that it is within budget is the same opinion that would
 * produce the bug; `tests/support/machine-probe.ts` shares no code with it and
 * asks the operating system instead.
 *
 * **Why this suite is off by default.** It has to hold several cores busy for
 * its whole window to measure anything, which is reasonable on a release runner
 * and unreasonable in an inner loop on a laptop — the machine this feature is
 * meant to stop overloading. Set `SOTY_POWER_LOAD=1` to run it. The skip is
 * visible and carries its reason, so it is counted like any other rather than
 * quietly becoming a suite nobody runs.
 */

/** The bound from SC-004: the average may not exceed the limit by more than this. */
const AVERAGE_TOLERANCE_POINTS = 10;
/**
 * How long the average is taken over.
 *
 * Overridable so the harness itself can be exercised in seconds rather than a
 * minute; SC-004's own figure is the default, and the release form uses it.
 */
const AVERAGE_WINDOW_MS = Number(process.env.SOTY_POWER_LOAD_WINDOW_MS) || 60_000;
/** No single stretch this long may exceed the limit by more than the tolerance. */
const WORST_STRETCH_MS = Math.min(10_000, Math.round(AVERAGE_WINDOW_MS / 4));
const SAMPLE_INTERVAL_MS = 500;

let directory = '';
const started: number[] = [];

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

/** Mean of a window of samples, in percentage points of the whole machine. */
function meanShare(samples: readonly MachineSample[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((total, sample) => total + sample.sotySharePercent, 0) / samples.length;
}

/** The worst mean across any contiguous stretch of the given length. */
function worstStretch(samples: readonly MachineSample[], stretchMs: number): number {
  const perStretch = Math.max(1, Math.round(stretchMs / SAMPLE_INTERVAL_MS));
  let worst = 0;
  for (let start = 0; start + perStretch <= samples.length; start += 1) {
    worst = Math.max(worst, meanShare(samples.slice(start, start + perStretch)));
  }
  return worst;
}

describeRequiring(requireEnvFlag('SOTY_POWER_LOAD'), 'concurrent tools share one budget', () => {
  /**
   * Enough concurrent burners to saturate the machine if nothing held them
   * back. Fewer would let the suite pass with the governor disconnected — on
   * an eight-core machine three busy processes are under 40% of it already,
   * so a limit of 40 would be met by arithmetic rather than by enforcement.
   */
  const SATURATING_TOOLS = Math.max(2, os.cpus().length);

  it.each([
    { limit: 40, tools: SATURATING_TOOLS },
    { limit: 70, tools: SATURATING_TOOLS }
  ])(
    'holds $tools tools inside a $limit% limit, on average and at worst',
    async ({ limit, tools }) => {
      directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-power-budget-'));
      const stub = await writeStubTool(directory, 'burn', {
        hang: true,
        burnCpu: true,
        burnFuseMs: AVERAGE_WINDOW_MS + 30_000
      });

      const governor = new PowerGovernor();
      await governor.setLimit(limit);

      for (let index = 0; index < tools; index += 1) {
        const child = spawnManaged(governor, process.execPath, [stub], {
          toolId: 'compressor',
          stdio: 'ignore'
        });
        if (typeof child.pid === 'number') started.push(child.pid);
      }

      const samples: MachineSample[] = [];
      let previous = await sampleMachine(process.pid);
      const deadline = Date.now() + AVERAGE_WINDOW_MS;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));
        previous = await sampleMachine(process.pid, previous);
        samples.push(previous);
      }

      await governor.shutdown();

      // Averaged over the whole window: the headline bound.
      expect(meanShare(samples)).toBeLessThanOrEqual(limit + AVERAGE_TOLERANCE_POINTS);
      // And no ten-second stretch inside it may be worse — an average that
      // hides a sustained overshoot behind a quiet tail is not a limit.
      expect(worstStretch(samples, WORST_STRETCH_MS)).toBeLessThanOrEqual(
        limit + AVERAGE_TOLERANCE_POINTS
      );
    },
    AVERAGE_WINDOW_MS + 60_000
  );
});
