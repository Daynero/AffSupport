import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  betaUpdateProfile,
  readArchiveBetaUpdateProfile,
  readBetaUpdateProfile,
  seedFixtureSmokeQueue
} from '../scripts/lib/native-update-profile.mjs';
import { removeTemporaryDirectory } from './support/temp-dir';
import { renderNativeUpdatePolicy } from '../scripts/lib/native-update-policy.mjs';
import { BETA_MARKERS, BETA_PROFILE } from '../packages/shared/src/environment';
import { describeRequiring, requirePlatform } from './support/requires.js';

const profileId = '10000000-0000-4000-8000-000000000001';
const options = {
  mode: 'beta',
  profileId,
  fixtureOrigin: 'http://127.0.0.1:43141',
  enabled: true,
  bundleId: 'com.wishly.beta'
};

describe('compiled fixture identity', () => {
  it.each(['arm64', 'x64'])('keeps beta identity out of the normal %s host policy', arch => {
    const production = renderNativeUpdatePolicy(arch);
    for (const marker of BETA_MARKERS) expect(production).not.toContain(marker);
    expect(production).toContain('fixtureBundleId: String? = nil');
    expect(production).toContain('fixtureSupportDirectory: String? = nil');
    const fixture = renderNativeUpdatePolicy(arch, true);
    expect(fixture).toContain(JSON.stringify(BETA_PROFILE.bundleId));
    expect(fixture).toContain(JSON.stringify(BETA_PROFILE.supportDirectoryName));
    expect(fixture).toContain(`target = "macos-${arch}"`);
  });
});

describe('sealed native updater qualification profile', () => {
  it.each(['beta', 'production', 'dev'])('preserves normal %s without fixture authority', mode => {
    expect(
      betaUpdateProfile({ ...options, mode, profileId: undefined, fixtureOrigin: undefined })
    ).toBeNull();
  });
  it('derives the same single directory segment for every sealed A/B/C process', () => {
    const runs = Array.from({ length: 3 }, () => betaUpdateProfile({ ...options }));
    expect(
      runs.every(profile => profile?.supportDirectoryName === `Soty Beta Updates ${profileId}`)
    ).toBe(true);
  });
  it.each([
    { mode: 'production' },
    { mode: 'dev' },
    { enabled: false },
    { bundleId: 'com.wishly' },
    { profileId: undefined },
    { profileId: '../Soty' },
    { profileId: '/tmp/profile' },
    { profileId: '10000000-0000-4000-8000-000000000001/../Soty' },
    { fixtureOrigin: undefined },
    { fixtureOrigin: 'https://example.com' },
    { fixtureOrigin: 'http://localhost:43141' },
    { fixtureOrigin: 'http://127.0.0.1:43141/path' },
    { fixtureOrigin: 'http://user@127.0.0.1:43141' },
    { fixtureOrigin: 'http://127.0.0.1:80' }
  ])('fails closed on invalid fixture authority: %j', override => {
    expect(() => betaUpdateProfile({ ...options, ...override })).toThrow();
  });
});

describeRequiring(requirePlatform('darwin'), 'exact archive profile binding', () => {
  it('preserves completed work/settings and refuses unfinished or aliased fixture state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-fixture-smoke-'));
    try {
      const stateFile = path.join(root, 'state.json');
      const original = {
        jobs: [{ id: 'existing', status: 'completed' }],
        settings: { preset: 'quality' },
        diagnosticEvidence: 'retained'
      };
      const seed = { jobs: [{ id: 'smoke', status: 'queued' }], settings: { preset: 'balanced' } };
      await writeFile(stateFile, JSON.stringify(original), { mode: 0o600 });
      seedFixtureSmokeQueue(root, seed);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
        ...original,
        jobs: [...original.jobs, ...seed.jobs]
      });
      const before = await readFile(stateFile, 'utf8');
      expect(() => seedFixtureSmokeQueue(root, seed)).toThrow('PROFILE_BUSY');
      expect(await readFile(stateFile, 'utf8')).toBe(before);
      await writeFile(stateFile, JSON.stringify(original));
      await mkdir(path.join(root, 'Updates/beta'), { recursive: true });
      await writeFile(
        path.join(root, 'Updates/beta/native.json'),
        JSON.stringify({ schemaVersion: 1, stage: 'install_committed' }),
        { mode: 0o600 }
      );
      expect(() => seedFixtureSmokeQueue(root, seed)).toThrow('PROFILE_BUSY');
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(original);
      const alias = path.join(root, 'alias');
      await mkdir(alias);
      await symlink(stateFile, path.join(alias, 'state.json'));
      expect(() => seedFixtureSmokeQueue(alias, seed)).toThrow();
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(original);
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
  it('checks the archived plist and rejects mismatched or missing B profile before serving it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-fixture-profile-'));
    try {
      const app = path.join(root, 'Soty Beta.app');
      const resources = path.join(app, 'Contents/Resources');
      await mkdir(resources, { recursive: true });
      await writeFile(path.join(resources, 'release.json'), JSON.stringify({ channel: 'beta' }));
      const plist = {
        CFBundleIdentifier: 'com.wishly.beta',
        SotyNativeUpdatesEnabled: true,
        SotyUpdateFixtureOrigin: options.fixtureOrigin,
        SotyUpdateFixtureProfile: profileId
      };
      const seal = async (value: object) => {
        const info = path.join(app, 'Contents/Info.plist');
        await writeFile(info, JSON.stringify(value));
        execFileSync('/usr/bin/plutil', ['-convert', 'xml1', info]);
        const archive = path.join(root, 'B.zip');
        execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
        return archive;
      };
      const archive = await seal(plist);
      expect((await readBetaUpdateProfile(app, { required: true }))?.profileId).toBe(profileId);
      expect(
        readArchiveBetaUpdateProfile(archive, profileId, options.fixtureOrigin).profileId
      ).toBe(profileId);
      expect(() =>
        readArchiveBetaUpdateProfile(
          archive,
          '20000000-0000-4000-8000-000000000002',
          options.fixtureOrigin
        )
      ).toThrow('PROFILE_MISMATCH');
      expect(() =>
        readArchiveBetaUpdateProfile(archive, profileId, 'http://127.0.0.1:43142')
      ).toThrow('PROFILE_MISMATCH');
      await seal({ ...plist, SotyUpdateFixtureProfile: undefined });
      expect(() => readArchiveBetaUpdateProfile(archive, profileId, options.fixtureOrigin)).toThrow(
        'PROFILE_INVALID'
      );
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
});
