import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  parseMacosTarget,
  macosPaths,
  nativeAcceptanceAllowed
} from '../scripts/lib/macos-target.mjs';

describe('macOS target boundary', () => {
  it('preserves ARM defaults and maps Intel toolchains', () => {
    expect(parseMacosTarget([])).toMatchObject({ arch: 'arm64', macho: 'arm64' });
    expect(parseMacosTarget(['--arch=x64'])).toMatchObject({
      arch: 'x64',
      platform: 'macos-x64',
      macho: 'x86_64',
      swift: 'x86_64-apple-macos13.0'
    });
    expect(parseMacosTarget(['--arch', 'x64'])).toEqual(parseMacosTarget(['--arch=x64']));
  });
  it.each([
    ['--arch=ia32'],
    ['--arch'],
    ['--arch=x64', '--arch=arm64'],
    ['--other'],
    ['--arch=../../']
  ])('refuses invalid arguments %j', (...args) => {
    expect(() => parseMacosTarget(args)).toThrow();
  });
  it('isolates flavors and targets without breaking existing ARM consumers', () => {
    for (const flavor of ['production', 'dev', 'beta']) {
      const arm = macosPaths('/repo', flavor, 'arm64');
      const intel = macosPaths('/repo', flavor, 'x64');
      expect(arm.root).not.toEqual(intel.root);
      expect(intel.root).toContain(`${path.sep}x64`);
      expect(intel.app).not.toEqual(arm.app);
    }
    expect(macosPaths('/repo', 'production', 'arm64').app).toBe(
      path.join('/repo', 'release', 'Soty.app')
    );
  });
  it('refuses Rosetta and cross-host execution as physical Intel acceptance', () => {
    expect(
      nativeAcceptanceAllowed({
        platform: 'darwin',
        runtimeArch: 'x64',
        targetArch: 'x64',
        armHardware: true,
        virtualized: false
      })
    ).toBe(false);
    expect(
      nativeAcceptanceAllowed({
        platform: 'darwin',
        runtimeArch: 'arm64',
        targetArch: 'x64',
        armHardware: true,
        virtualized: false
      })
    ).toBe(false);
    expect(
      nativeAcceptanceAllowed({
        platform: 'darwin',
        runtimeArch: 'x64',
        targetArch: 'x64',
        armHardware: null,
        virtualized: false
      })
    ).toBe(false);
    expect(
      nativeAcceptanceAllowed({
        platform: 'darwin',
        runtimeArch: 'x64',
        targetArch: 'x64',
        virtualized: false,
        armHardware: false
      })
    ).toBe(true);
  });
  it('refuses virtualized or unknown physical Intel identity', () => {
    for (const virtualized of [true, null])
      expect(
        nativeAcceptanceAllowed({
          platform: 'darwin',
          runtimeArch: 'x64',
          targetArch: 'x64',
          armHardware: false,
          virtualized
        })
      ).toBe(false);
  });
  it('validates target before launching a composite build', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/package-macos.mjs', 'dev-dmg', '--arch=bogus'], {
        encoding: 'utf8',
        stdio: 'pipe'
      })
    ).toThrow();
  });
});
