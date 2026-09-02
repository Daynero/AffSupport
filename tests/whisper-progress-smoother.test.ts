import { describe, expect, it } from 'vitest';
import { ProgressSmoother } from '../apps/agent/src/whisper/progress-smoother.js';
import { lastOutTimeSeconds } from '../apps/agent/src/whisper/transcriber.js';

/**
 * A progress bar you can read.
 *
 * What the work reports is nothing for ten seconds, a jump to twenty percent, a few
 * four-percent steps and then long silences. From that, nobody can tell a run that is thinking
 * from one that has hung, or guess how much longer it will be — which is the only question the
 * bar is asked. The figure is therefore smoothed between real reports, under two rules that
 * keep it honest: it never goes backwards, and it stops moving when the work does.
 */

function smootherAt(clock: { ms: number }, decimals = 0) {
  const seen: number[] = [];
  const smoother = new ProgressSmoother({
    emit: value => seen.push(value),
    now: () => clock.ms,
    decimals
  });
  return { smoother, seen };
}

describe('a progress figure between reports', () => {
  it('creeps towards the next report instead of sitting still', () => {
    const clock = { ms: 0 };
    // A decimal place, so the rule is read rather than the rounding.
    const { smoother, seen } = smootherAt(clock, 1);

    smoother.report(0);
    clock.ms = 10_000;
    smoother.report(20); // 2% a second, learned from the run itself.

    clock.ms = 12_000;
    smoother.tick();
    const crept = seen.at(-1) ?? 0;
    // Moving, and short of where the next real report is expected — arriving early and
    // waiting is the thing that makes a bar look stuck.
    expect(crept).toBeGreaterThan(20);
    expect(crept).toBeLessThan(24);
  });

  it('never goes backwards, even when the truth is behind the estimate', () => {
    const clock = { ms: 0 };
    const { smoother, seen } = smootherAt(clock);
    smoother.report(0);
    clock.ms = 10_000;
    smoother.report(30);
    clock.ms = 14_000;
    smoother.tick();
    const crept = seen.at(-1) ?? 0;

    // The work reports something lower than the estimate had reached.
    smoother.report(31);
    // A bar that goes backwards reads as a failure even when the newer figure is the more
    // accurate one, so the estimate is held rather than undone.
    expect(seen.at(-1)).toBeGreaterThanOrEqual(crept);
  });

  it('stops moving when the reports stop, so a stall still looks like one', () => {
    const clock = { ms: 0 };
    const { smoother, seen } = smootherAt(clock);
    smoother.report(0);
    clock.ms = 5_000;
    smoother.report(10);

    for (let minute = 1; minute <= 20; minute += 1) {
      clock.ms = 5_000 + minute * 60_000;
      smoother.tick();
    }
    // It creeps, but it can never reach the end on its own: only the work finishes the run.
    expect(seen.at(-1)).toBeLessThan(100);
  });

  it('does not invent movement before the work has reported anything', () => {
    const clock = { ms: 0 };
    const { smoother, seen } = smootherAt(clock);
    smoother.report(0);
    clock.ms = 30_000;
    smoother.tick();
    // No rate has been observed yet, so there is nothing to extrapolate from.
    expect(seen).toEqual([0]);
  });

  it('ends where the run says it ended', () => {
    const clock = { ms: 0 };
    const { smoother, seen } = smootherAt(clock);
    smoother.report(0);
    clock.ms = 1_000;
    smoother.report(40);
    smoother.finish(100);
    expect(seen.at(-1)).toBe(100);
  });
});

describe('the position ffmpeg reports while extracting', () => {
  it('reads the last one in a block', () => {
    const block =
      'bitrate=  256.0kbits/s\nout_time_ms=1000000\nprogress=continue\n' +
      'out_time_ms=2500000\nprogress=continue\n';
    // Microseconds despite the name, which is why this is parsed rather than trusted.
    expect(lastOutTimeSeconds(block)).toBe(2.5);
  });

  it('reports nothing from a block that carries no position', () => {
    expect(lastOutTimeSeconds('frame=1\nfps=0.0\nprogress=continue\n')).toBeNull();
    expect(lastOutTimeSeconds('')).toBeNull();
  });
});
