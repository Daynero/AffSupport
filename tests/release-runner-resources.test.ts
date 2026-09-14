import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admission,
  pressureDecision,
  reservationFor,
  stableWindow,
  validateProfile,
  windowVerdict
} from '../scripts/lib/release/resources.mjs';
import { readResidentReservations } from '../scripts/lib/release/adapters/beta.mjs';
import {
  createProbeSampler,
  deriveSample,
  parseReading
} from '../scripts/lib/release/probes-macos.mjs';
import profiles from '../config/release-resource-profiles.json';
import { itRequiring, requirePlatform } from './support/requires.js';
/**
 * This case reads the installed arm64 probe. Absent, every derived signal is
 * null and the assertions describe the platform rather than the admission rule.
 */
const posixReleaseHost = requirePlatform('darwin', 'linux');

describe('resource admission', () => {
  it('contains every registered heavy class with a conservative bounded profile', () => {
    for (const name of [
      'shared_compile',
      'dependency_install',
      'serial_tests',
      'web_agent_native_build',
      'beta_stack',
      'package_archive',
      'hash_download',
      'unknown_registered_heavy'
    ]) {
      expect((profiles.default.classes as Record<string, unknown>)[name]).toMatchObject({
        ramBytes: expect.any(Number),
        diskBytes: expect.any(Number),
        timeoutMs: expect.any(Number)
      });
    }
  });
  it('requires a complete 30-second healthy window and never accepts unknown pressure', async () => {
    const { default: profile } = JSON.parse(
      await readFile('config/release-resource-profiles.json', 'utf8')
    );
    validateProfile(profile);
    const healthy = Array.from({ length: 7 }, (_, index) => ({
      observedAt: new Date(1_000 + index * 5_000).toISOString(),
      cpuPercent: 20,
      availableBytes: 8e9,
      pressure: 'normal',
      swapGrowthBytes: 0,
      diskFreeBytes: 20e9,
      thermal: 'nominal',
      bootId: 'boot-a'
    }));
    expect(stableWindow(healthy, profile)).toBe(true);
    expect(admission({ ...healthy[0], pressure: null }, profile)).toMatchObject({
      reason: 'RESOURCE_SIGNAL_UNKNOWN'
    });
  });
  it('names the condition that refused the window, with the numbers that decided it', async () => {
    const { default: profile } = JSON.parse(
      await readFile('config/release-resource-profiles.json', 'utf8')
    );
    const reading = (index: number, availableBytes: number) => ({
      observedAt: new Date(1_000 + index * 5_000).toISOString(),
      cpuPercent: 20,
      availableBytes,
      pressure: 'normal',
      swapGrowthBytes: 0,
      diskFreeBytes: 20e9,
      thermal: 'nominal',
      bootId: 'boot-a'
    });
    // Two readings into a machine nobody has measured yet: patience, and it
    // says so rather than looking identical to paralysis.
    expect(windowVerdict([reading(0, 8e9), reading(1, 8e9)], profile)).toMatchObject({
      ok: false,
      code: 'WINDOW_TOO_SHORT',
      detail: '2 of 7 readings taken'
    });
    // A full window on a machine that is short of memory. `RESOURCE_WAIT` alone
    // cost two releases an hour each, because this is the wait that does not end
    // on its own and nothing distinguished it from the wait that does.
    const short = Array.from({ length: 7 }, (_, index) => reading(index, 2e9));
    const verdict = windowVerdict(short, profile, { ramBytes: 4e9, diskBytes: 0 });
    expect(verdict).toMatchObject({ ok: false, code: 'RESOURCE_INSUFFICIENT' });
    expect(verdict.detail).toContain('ram 1.86 GiB available');
    expect(verdict.detail).toContain('4.73 GiB needed');
    expect(stableWindow(short, profile, { ramBytes: 4e9, diskBytes: 0 })).toBe(false);
  });

  it('stops charging for a beta stack whose owner process is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'soty-reservation-'));
    try {
      const record = (ownerPid: number) =>
        JSON.stringify({
          schemaVersion: 1,
          ownerPid,
          stackStarted: true,
          reservation: { ramBytes: 3221225472, diskBytes: 8589934592 }
        });
      // This process is alive by definition, so its claim still stands.
      await writeFile(join(directory, 'beta-service.json'), record(process.pid));
      expect(await readResidentReservations(directory)).toMatchObject({ ramBytes: 3221225472 });
      // A pid above the platform's maximum has never existed. The record is a
      // receipt that outlived its effect, and three phantom gigabytes on a
      // sixteen-gigabyte machine is the difference between running and waiting
      // for memory that was never taken.
      await writeFile(join(directory, 'beta-service.json'), record(4_194_304));
      expect(await readResidentReservations(directory)).toEqual({ ramBytes: 0, diskBytes: 0 });
      // Naming no owner is an unprovable claim, not a disproved one.
      await writeFile(
        join(directory, 'beta-service.json'),
        JSON.stringify({
          schemaVersion: 1,
          stackStarted: true,
          reservation: { ramBytes: 3221225472, diskBytes: 8589934592 }
        })
      );
      expect(await readResidentReservations(directory)).toMatchObject({ ramBytes: 3221225472 });
    } finally {
      await removeTemporaryDirectory(directory);
    }
  });

  it('terminates only owned interruptible work after two critical samples', () => {
    const samples = [{ pressure: 'critical' }, { pressure: 'critical' }];
    expect(pressureDecision(samples, { owned: true, interruptible: true })).toEqual({
      action: 'terminate_and_retry_once'
    });
    expect(pressureDecision(samples, { owned: true, interruptible: false })).toEqual({
      action: 'reconcile_boundary'
    });
  });
  it('resets admission on stale/sleep samples and does not subtract resident RSS twice', async () => {
    const { default: profile } = JSON.parse(
      await readFile('config/release-resource-profiles.json', 'utf8')
    );
    const samples = Array.from({ length: 7 }, (_, index) => ({
      observedAt: new Date(index * 5_000).toISOString(),
      cpuPercent: 10,
      availableBytes: 8e9,
      pressure: 'normal',
      swapGrowthBytes: 0,
      diskFreeBytes: 20e9,
      thermal: 'nominal',
      bootId: 'a'
    }));
    expect(
      stableWindow(
        [...samples.slice(0, 6), { ...samples[6], observedAt: new Date(60_000).toISOString() }],
        profile
      )
    ).toBe(false);
    expect(stableWindow([...samples.slice(0, 6), { ...samples[6], sleep: true }], profile)).toBe(
      false
    );
    expect(reservationFor(profile.classes.package_archive, { residentBytes: 1e9 }).ramBytes).toBe(
      profile.classes.package_archive.ramBytes - 1e9
    );
  });
});

describe('installed probe readings', () => {
  /** A stand-in that speaks the probe protocol, so the test needs no toolchain. */
  async function fakeProbe(readings: unknown[]) {
    const root = await mkdtemp(join(tmpdir(), 'release-probe-readings-'));
    const state = join(root, 'index');
    const executable = join(root, 'probe');
    await writeFile(state, '0');
    await writeFile(
      executable,
      `#!/bin/sh\nindex=$(cat ${state})\nexpr $index + 1 > ${state}\ncase "$index" in\n` +
        readings
          .map((reading, index) => `${index}) printf '%s\\n' '${JSON.stringify(reading)}';;`)
          .join('\n') +
        `\n*) exit 1;;\nesac\n`
    );
    await chmod(executable, 0o755);
    return { root, executable };
  }

  const reading = (index: number, overrides: Record<string, unknown> = {}) => ({
    version: 1,
    observedAt: new Date(1_000 + index * 5_000).toISOString(),
    uptimeNs: (1_000 + index * 5_000) * 1e6,
    bootId: 'boot-a',
    physicalBytes: 17179869184,
    cpuCount: 8,
    cpuTicks: { user: index * 100, system: 0, nice: 0, idle: index * 900 },
    availableBytes: 8e9,
    pressure: 'normal',
    swapUsedBytes: 0,
    diskFreeBytes: 20e9,
    thermal: 'nominal',
    ...overrides
  });

  itRequiring(
    posixReleaseHost,
    'cannot admit on a first reading and admits only once every mandatory signal is derived',
    async () => {
      const { default: profile } = JSON.parse(
        await readFile('config/release-resource-profiles.json', 'utf8')
      );
      const { root, executable } = await fakeProbe([reading(0), reading(1), reading(2)]);
      try {
        const sampler = createProbeSampler({ executable });
        const first = await sampler.sample();
        // Nothing to subtract from: a rate signal cannot exist yet.
        expect(first).toMatchObject({ cpuPercent: null, swapGrowthBytes: null });
        expect(admission(first, profile)).toMatchObject({ reason: 'RESOURCE_SIGNAL_UNKNOWN' });

        const second = await sampler.sample();
        expect(second.cpuPercent).toBeCloseTo(10, 5);
        for (const signal of [
          'cpuPercent',
          'availableBytes',
          'pressure',
          'swapGrowthBytes',
          'diskFreeBytes',
          'thermal'
        ] as const) {
          expect(second[signal]).not.toBeNull();
        }
        expect(admission(second, profile)).toMatchObject({ ok: true });
      } finally {
        await removeTemporaryDirectory(root);
      }
    }
  );

  it('treats an incomplete reading as unknown and notices a machine that slept', async () => {
    const { default: profile } = JSON.parse(
      await readFile('config/release-resource-profiles.json', 'utf8')
    );
    const incomplete = reading(1) as Record<string, unknown>;
    delete incomplete.availableBytes;
    const { root, executable } = await fakeProbe([reading(0), incomplete]);
    try {
      const sampler = createProbeSampler({ executable });
      await sampler.sample();
      const broken = await sampler.sample();
      expect(admission(broken, profile)).toMatchObject({ reason: 'RESOURCE_SIGNAL_UNKNOWN' });
    } finally {
      await removeTemporaryDirectory(root);
    }

    // Wall clock advanced an hour while the uptime clock advanced five seconds.
    const slept = deriveSample(
      [parseReading(reading(0, { observedAt: new Date(0).toISOString(), uptimeNs: 0 }))],
      parseReading(reading(0, { observedAt: new Date(3_600_000).toISOString(), uptimeNs: 5_000e6 }))
    );
    expect(slept.sleep).toBe(true);
  });

  it('measures swap growth across the whole window, not between neighbours', () => {
    const history = [0, 100e6, 200e6].map((swapUsedBytes, index) =>
      parseReading(reading(index, { swapUsedBytes }))
    );
    const sample = deriveSample(history, parseReading(reading(3, { swapUsedBytes: 300e6 })));
    expect(sample.swapGrowthBytes).toBe(300e6);
  });
});
