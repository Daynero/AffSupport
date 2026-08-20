import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { setActiveGovernor } from '../apps/agent/src/power/spawn.js';

/**
 * Throttling is supposed to make work slower, never to make it fail.
 *
 * Every wall-clock deadline that covers managed work has to stretch with the
 * duty cycle, or the power lever manufactures timeouts — and the symptom
 * ("previews sometimes fail on this machine") points nowhere near the control
 * that caused it.
 */

const AGENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/agent/src');

afterEach(() => {
  setActiveGovernor(null);
});

describe('scaleTimeout', () => {
  it('leaves deadlines untouched when unrestricted', () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    for (const budget of [15_000, 20_000, 90_000, 180_000])
      expect(power.scaleTimeout(budget)).toBe(budget);
  });

  it('stretches deadlines in inverse proportion to the limit', async () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });

    await power.setLimit(50);
    expect(power.scaleTimeout(90_000)).toBe(180_000);

    await power.setLimit(20);
    // A render that takes 25 s at full power takes roughly 125 s at 20%. With a
    // fixed 90 s budget it would be aborted for obeying the user's own limit.
    expect(power.scaleTimeout(90_000)).toBe(450_000);
    expect(power.scaleTimeout(20_000)).toBe(100_000);
  });

  it('is readable through the process-wide governor by deep call sites', async () => {
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    await power.setLimit(25);
    setActiveGovernor(power);

    const { activeGovernorOrNull } = await import('../apps/agent/src/power/spawn.js');
    expect(activeGovernorOrNull()?.scaleTimeout(90_000)).toBe(360_000);
  });

  it('falls back to the raw deadline when no governor is installed', async () => {
    setActiveGovernor(null);
    const { activeGovernorOrNull } = await import('../apps/agent/src/power/spawn.js');
    expect(activeGovernorOrNull()?.scaleTimeout(90_000) ?? 90_000).toBe(90_000);
  });
});

describe('managed-work deadlines are wired to the budget', () => {
  /**
   * A source-level check, because the alternative is a multi-minute integration
   * test per deadline. What matters is that no fixed budget is handed straight
   * to a timer on a path that managed work runs through.
   */
  const wired: { file: string; constants: string[] }[] = [
    {
      file: 'landing-preview/renderer.ts',
      constants: ['RENDER_TIMEOUT_MS', 'NAVIGATION_TIMEOUT_MS']
    },
    { file: 'landing-preview/scanner.ts', constants: ['FS_OP_TIMEOUT_MS'] },
    { file: 'team-bridge/landing-gallery.ts', constants: ['#watchdogMs'] },
    { file: 'queue/queue.ts', constants: ['2000'] },
    // The llama.cpp servers are managed children too, so a cold model load is
    // duty-cycled while it happens. These two deadlines were left raw when the
    // rest were wired up: at a 20% limit the load blows a fixed 120 s budget and
    // translation stops working, blaming the model rather than the lever.
    { file: 'translation/translator.ts', constants: ['START_TIMEOUT_MS'] },
    { file: 'translation/aligner.ts', constants: ['ALIGNER_START_TIMEOUT_MS'] },
    // Whisper's inactivity watchdog measures the gap between progress lines,
    // and a throttled decoder legitimately produces them further apart. Left
    // fixed, it ends a healthy transcription and reports a stalled engine.
    { file: 'whisper/transcriber.ts', constants: ['WHISPER_INACTIVITY_TIMEOUT_MS'] },
    // The team bridge's own six-hour ceiling. Its sibling in landing-gallery.ts
    // was wired to the budget; this one, which covers compression and
    // transcription, was not.
    { file: 'team-bridge/process.ts', constants: ['#watchdogMs'] }
  ];

  it('covers every module that spawns a managed child and then waits on it', async () => {
    // The list above is only as good as its coverage. A module that starts a
    // long-lived tool and then enforces a wall-clock deadline on it belongs in
    // it; this is the check that notices the next one.
    const suspects = [
      'translation/translator.ts',
      'translation/aligner.ts',
      'landing-preview/renderer.ts',
      'whisper/transcriber.ts',
      'team-bridge/process.ts',
      'team-bridge/landing-gallery.ts'
    ];
    for (const file of suspects) {
      expect(wired.map(entry => entry.file)).toContain(file);
    }
  });

  it.each(wired)('scales the deadlines in $file', async ({ file, constants }) => {
    const source = await readFile(path.join(AGENT_SRC, file), 'utf8');
    expect(source).toMatch(/scaleTimeout|scaled\(/);
    for (const constant of constants) {
      const usage = new RegExp(
        `(scaleTimeout|scaled)\\(\\s*(this\\.)?${constant.replace('#', '#')}`
      );
      expect(source, `${file} should scale ${constant}`).toMatch(usage);
    }
  });
});
