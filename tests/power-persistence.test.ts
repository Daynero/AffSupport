import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPowerState, powerStatePath, savePowerLimit } from '../apps/agent/src/power/store.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { POWER_LIMIT_MAX } from '../packages/shared/src/types.js';

const directories: string[] = [];

async function temporaryStore(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soty-power-'));
  directories.push(dir);
  return path.join(dir, 'power.json');
}

afterEach(async () => {
  while (directories.length) {
    const dir = directories.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  delete process.env.AGENT_POWER_STATE_PATH;
});

describe('power.json', () => {
  it('round-trips a stored limit', async () => {
    const file = await temporaryStore();
    await savePowerLimit(40, file);
    const loaded = await loadPowerState(file);
    expect(loaded?.limitPercent).toBe(40);
    expect(typeof loaded?.updatedAt).toBe('string');
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const file = await temporaryStore();
    await savePowerLimit(40, file);
    // A crash mid-write must leave the old value or the new one, never a
    // half-written file that reads as corrupt on next boot.
    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.dirname(file));
    expect(entries.filter(entry => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('honours the test path override', () => {
    // Was a hardcoded '/tmp/soty-power-override.json': shared by every concurrent run on
    // the machine, and not a path that exists on Windows at all — so this assertion could
    // never have run on the platform the feature has to work on.
    const override = path.join(os.tmpdir(), `soty-power-override-${process.pid}.json`);
    process.env.AGENT_POWER_STATE_PATH = override;
    expect(powerStatePath()).toBe(override);
  });

  it('lives in its own file, not the compressor queue state', () => {
    delete process.env.AGENT_POWER_STATE_PATH;
    expect(path.basename(powerStatePath())).toBe('power.json');
  });
});

describe('a store that cannot be trusted', () => {
  it('returns nothing when the file does not exist', async () => {
    const file = await temporaryStore();
    expect(await loadPowerState(file)).toBeNull();
  });

  it.each([
    ['unparseable', 'not json at all'],
    ['the wrong shape', '{"limit":40}'],
    ['a non-numeric limit', '{"limitPercent":"40"}'],
    ['an array', '[40]'],
    ['out of range low', '{"limitPercent":3}'],
    ['out of range high', '{"limitPercent":400}']
  ])('falls back to unrestricted when the file is %s', async (_label, contents) => {
    const file = await temporaryStore();
    await writeFile(file, contents, 'utf8');
    // The safe failure direction is "Soty runs at full speed", never "Soty is
    // mysteriously stuck at 3%".
    expect(await loadPowerState(file)).toBeNull();
  });

  it('leaves the governor at its default when nothing loads', async () => {
    const file = await temporaryStore();
    await writeFile(file, 'garbage', 'utf8');
    const power = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const restored = await loadPowerState(file);
    if (restored) power.adoptPersistedLimit(restored.limitPercent, restored.updatedAt);
    expect(power.limitPercent()).toBe(POWER_LIMIT_MAX);
  });
});

describe('persistence and the applied limit never diverge', () => {
  it('does not apply a limit it could not write', async () => {
    const file = await temporaryStore();
    const directory = path.dirname(file);
    await chmod(directory, 0o500);

    const power = new PowerGovernor({
      cpuCount: 8,
      pauseSupported: true,
      persist: limitPercent => savePowerLimit(limitPercent, file)
    });

    await expect(power.setLimit(40)).rejects.toThrow();
    // A lever pointing at a limit that will not survive a restart is worse than
    // a visible error.
    expect(power.limitPercent()).toBe(POWER_LIMIT_MAX);
    expect(await loadPowerState(file)).toBeNull();

    await chmod(directory, 0o700);
  });

  it('applies and stores the same value on success', async () => {
    const file = await temporaryStore();
    const power = new PowerGovernor({
      cpuCount: 8,
      pauseSupported: true,
      persist: limitPercent => savePowerLimit(limitPercent, file)
    });

    await power.setLimit(40);
    expect(power.limitPercent()).toBe(40);
    expect((await loadPowerState(file))?.limitPercent).toBe(40);
  });

  it('survives a restart', async () => {
    const file = await temporaryStore();
    await savePowerLimit(40, file);

    const restarted = new PowerGovernor({ cpuCount: 8, pauseSupported: true });
    const restored = await loadPowerState(file);
    expect(restored).not.toBeNull();
    if (restored) restarted.adoptPersistedLimit(restored.limitPercent, restored.updatedAt);
    expect(restarted.limitPercent()).toBe(40);
    expect(restarted.state().mode).toBe('limited');
  });
});
