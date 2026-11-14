import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  nativeUpdateInputsPreflight,
  nativeUpdatesDisabled
} from '../scripts/lib/native-update-inputs.mjs';
import {
  assertNativeUpdateQualification,
  NATIVE_UPDATE_QUALIFICATION_CASES
} from '../scripts/lib/native-update-qualification.mjs';
import { SPARKLE } from '../scripts/lib/native-update-sdk.mjs';
import { nativeUpdateMatchesManifest } from '../packages/shared/src/native-app-updates';
import { nativeCandidate } from './support/native-app-updates';
const sha = 'a'.repeat(40);
function proof() {
  return {
    schemaVersion: 1,
    kind: 'native-update-qualification',
    sourceSha: sha,
    sdkSha256: SPARKLE.sha256,
    targets: ['macos-arm64', 'macos-x64'],
    intelEvidence: 'static-intel-user-feedback-v1',
    cases: NATIVE_UPDATE_QUALIFICATION_CASES.map(name => ({
      name,
      status: 'passed',
      evidenceSha256: 'b'.repeat(64)
    })),
    trust: ['macos-arm64', 'macos-x64'].map(target => ({
      target,
      developerId: true,
      notarized: true,
      stapled: true,
      packageSha256: 'c'.repeat(64)
    })),
    latencySamples: Array.from({ length: 20 }, () => ({
      readyMs: 1000,
      workMs: 5000,
      osConsentMs: 2000,
      downloadMs: 10000
    }))
  };
}
describe('native updater release eligibility', () => {
  it('requires complete exact-source qualification with separate Intel evidence', () => {
    expect(assertNativeUpdateQualification(proof(), sha).intelEvidence).toBe(
      'static-intel-user-feedback-v1'
    );
    expect(() => assertNativeUpdateQualification(proof(), 'd'.repeat(40))).toThrow(
      'NATIVE_UPDATE_QUALIFICATION_REQUIRED'
    );
    const missing = proof();
    missing.cases.pop();
    expect(() => assertNativeUpdateQualification(missing, sha)).toThrow();
    const wrongSdk = { ...proof(), sdkSha256: 'e'.repeat(64) };
    expect(() => assertNativeUpdateQualification(wrongSdk, sha)).toThrow();
  });
  it('keeps the latency and Apple trust gates mandatory', () => {
    const slow = proof();
    slow.latencySamples.forEach(sample => {
      sample.readyMs = 61000;
    });
    expect(() => assertNativeUpdateQualification(slow, sha)).toThrow(
      'NATIVE_UPDATE_LATENCY_TARGET'
    );
    const unsigned = proof();
    unsigned.trust[0]!.stapled = false;
    expect(() => assertNativeUpdateQualification(unsigned, sha)).toThrow();
  });
  it('never binds a descriptor to a different promoted build', () => {
    expect(
      nativeUpdateMatchesManifest(nativeCandidate(), {
        version: '9.0.0',
        buildId: '9.0.0+998',
        buildNumber: '998'
      })
    ).toBe(false);
  });
});

describe('Developer ID build with the native updater switched off by the owner', () => {
  it('accepts only the explicit value and fails closed on anything else', () => {
    expect(nativeUpdatesDisabled({})).toBe(false);
    expect(nativeUpdatesDisabled({ SOTY_NATIVE_UPDATES: '' })).toBe(false);
    expect(nativeUpdatesDisabled({ SOTY_NATIVE_UPDATES: 'disabled' })).toBe(true);
    for (const typo of ['off', 'false', 'Disabled', 'enabled'])
      expect(() => nativeUpdatesDisabled({ SOTY_NATIVE_UPDATES: typo })).toThrow(
        'NATIVE_UPDATES_POLICY_INVALID'
      );
  });

  it('skips the updater key and qualification only when switched off', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-native-off-'));
    try {
      await expect(
        nativeUpdateInputsPreflight(root, sha, { SOTY_NATIVE_UPDATES: 'disabled' })
      ).resolves.toEqual({ enabled: false, disabledByOwner: true });
      // Without the switch the same machine still has to prove key and qualification.
      await expect(
        nativeUpdateInputsPreflight(root, sha, { SOTY_UPDATER_KEY_PATH: path.join(root, 'x') })
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin')(
    'packages a signed production app with the updater off and no qualification record',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'soty-native-off-app-'));
      const app = path.join(root, 'Soty.app');
      try {
        await mkdir(path.join(app, 'Contents'), { recursive: true });
        const plist = path.join(app, 'Contents/Info.plist');
        const empty =
          '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n';
        const configure = (extra: Record<string, string>) =>
          spawnSync(process.execPath, ['scripts/configure-native-updates.mjs', app, 'production'], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              SOTY_SIGNING_IDENTITY: 'Developer ID Application: Test',
              ...extra
            }
          });
        await writeFile(plist, empty);
        const refused = configure({});
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('NATIVE_UPDATE_QUALIFICATION_REQUIRED');

        await writeFile(plist, empty);
        const off = configure({ SOTY_NATIVE_UPDATES: 'disabled' });
        expect(off.stderr).toBe('');
        expect(off.status).toBe(0);
        const read = spawnSync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print :SotyNativeUpdatesEnabled', plist],
          { encoding: 'utf8' }
        );
        expect(read.stdout.trim()).toBe('false');

        await writeFile(plist, empty);
        const typo = configure({ SOTY_NATIVE_UPDATES: 'off' });
        expect(typo.status).not.toBe(0);
        expect(typo.stderr).toContain('NATIVE_UPDATES_POLICY_INVALID');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
