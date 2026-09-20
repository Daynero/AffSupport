import { describe, expect, it } from 'vitest';
import { probeExecutable } from '../apps/agent/src/platform/probe.js';
import { commandExists } from '../apps/agent/src/ffmpeg/tools.js';

const missing = '/definitely/not/a/binary/soty-probe-fixture';

describe('probeExecutable', () => {
  it('answers no instead of throwing when spawn itself refuses', async () => {
    // The Windows crash this exists for: a bundled binary the system declines to
    // launch fails with UNKNOWN, which node throws from spawn rather than emitting
    // as an 'error' event. An invalid command reaches the same throw on any OS.
    await expect(probeExecutable('', ['-version'])).resolves.toEqual({
      runnable: false,
      failure: expect.any(String)
    });
  });

  it('reports a missing binary as ENOENT', async () => {
    await expect(probeExecutable(missing, ['-version'])).resolves.toEqual({
      runnable: false,
      failure: 'ENOENT'
    });
  });

  it('counts only a clean exit as runnable', async () => {
    await expect(probeExecutable(process.execPath, ['-e', ''])).resolves.toEqual({
      runnable: true,
      failure: null
    });
    await expect(probeExecutable(process.execPath, ['-e', 'process.exit(3)'])).resolves.toEqual({
      runnable: false,
      failure: 'EXIT_3'
    });
  });

  it('gives up on a probe that never returns', async () => {
    await expect(
      probeExecutable(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], 150)
    ).resolves.toEqual({ runnable: false, failure: 'TIMEOUT' });
  });
});

describe('commandExists', () => {
  it('stays a yes/no over the same probe', async () => {
    await expect(commandExists('')).resolves.toBe(false);
    await expect(commandExists(missing)).resolves.toBe(false);
  });
});
