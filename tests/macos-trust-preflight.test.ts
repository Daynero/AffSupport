import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { macosTrustPreflight } from '../scripts/lib/release/macos-trust-preflight.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * 048 FR-006 / T019. Before the runner builds anything for a `developer-id` release it
 * proves the identity, its team, its validity and the notary profile. The keychain and
 * Apple are stand-ins here; a real certificate is made with openssl where one exists,
 * because the team and the expiry are read from the certificate, not from its name.
 */

const TEAM = 'ABCDEFGHIJ';
const IDENTITY = `Developer ID Application: Fixture (${TEAM})`;
const complete = {
  SOTY_SIGNING_IDENTITY: IDENTITY,
  MACOS_EXPECTED_TEAM_ID: TEAM,
  SOTY_NOTARY_KEYCHAIN_PROFILE: 'soty-notary'
};
const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

async function selfSignedCertificate(team: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-preflight-cert-'));
  directories.push(root);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(root, 'key.pem'),
      '-out',
      path.join(root, 'cert.pem'),
      '-days',
      '30',
      '-subj',
      `/C=UA/O=Fixture/OU=${team}/CN=Developer ID Application: Fixture (${team})`
    ],
    { stdio: 'pipe', timeout: 30000 }
  );
  return readFile(path.join(root, 'cert.pem'), 'utf8');
}

type Fake = { identities?: string; pem?: string; notaryFails?: boolean };
function fakeExec(fake: Fake) {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === 'security' && args[0] === 'find-identity')
      return { stdout: fake.identities ?? '     0 valid identities found\n', stderr: '' };
    if (file === 'security' && args[0] === 'find-certificate')
      return { stdout: fake.pem ?? '', stderr: '' };
    if (file === 'xcrun' && args[0] === 'notarytool') {
      if (fake.notaryFails) throw new Error('Error: HTTP status code: 401');
      return { stdout: 'No submissions\n', stderr: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}
const listing = `  1) 0123456789ABCDEF "${IDENTITY}"\n     1 valid identities found\n`;

describe('trust preflight before packaging', () => {
  it('checks nothing under the explicit pre-048 policy and refuses an unknown one', async () => {
    const { exec, calls } = fakeExec({});
    await expect(
      macosTrustPreflight({ SOTY_MACOS_TRUST_POLICY: 'adhoc-pre-048' }, { exec })
    ).resolves.toEqual({ policy: 'adhoc-pre-048', checked: false });
    expect(calls).toEqual([]);
    await expect(
      macosTrustPreflight({ SOTY_MACOS_TRUST_POLICY: 'adhoc' }, { exec })
    ).rejects.toThrow('MACOS_TRUST_POLICY_INVALID');
  });

  it('names every missing input at once, before touching the keychain', async () => {
    const { exec, calls } = fakeExec({});
    await expect(macosTrustPreflight({}, { exec })).rejects.toThrow(
      'MACOS_TRUST_INPUTS_MISSING: SOTY_SIGNING_IDENTITY, MACOS_EXPECTED_TEAM_ID, SOTY_NOTARY_KEYCHAIN_PROFILE'
    );
    // The ad-hoc identity is not an identity for this purpose.
    await expect(
      macosTrustPreflight({ ...complete, SOTY_SIGNING_IDENTITY: '-' }, { exec })
    ).rejects.toThrow('MACOS_TRUST_INPUTS_MISSING: SOTY_SIGNING_IDENTITY');
    await expect(
      macosTrustPreflight({ ...complete, MACOS_EXPECTED_TEAM_ID: 'abc' }, { exec })
    ).rejects.toThrow('MACOS_TRUST_INPUTS_MISSING: MACOS_EXPECTED_TEAM_ID');
    expect(calls).toEqual([]);
  });

  it('refuses an identity the keychain does not list as valid', async () => {
    const { exec, calls } = fakeExec({});
    await expect(macosTrustPreflight(complete, { exec })).rejects.toThrow(
      `MACOS_TRUST_IDENTITY_MISSING: ${IDENTITY}`
    );
    expect(calls).toEqual([['security', 'find-identity', '-v', '-p', 'codesigning']]);
  });

  it.skipIf(!opensslAvailable)(
    'reads the team and the expiry from the certificate, then asks Apple about the profile [needs: openssl]',
    async () => {
      const pem = await selfSignedCertificate(TEAM);
      const other = await selfSignedCertificate('ZZZZZZZZZZ');
      await expect(
        macosTrustPreflight(complete, { exec: fakeExec({ identities: listing, pem: other }).exec })
      ).rejects.toThrow(
        'MACOS_TRUST_TEAM_MISMATCH: certificate team ZZZZZZZZZZ, expected ABCDEFGHIJ'
      );
      await expect(
        macosTrustPreflight(complete, {
          exec: fakeExec({ identities: listing, pem }).exec,
          now: () => Date.now() + 365 * 24 * 60 * 60 * 1000
        })
      ).rejects.toThrow('MACOS_TRUST_IDENTITY_EXPIRED');
      await expect(
        macosTrustPreflight(complete, {
          exec: fakeExec({ identities: listing, pem, notaryFails: true }).exec
        })
      ).rejects.toThrow('MACOS_TRUST_NOTARY_PROFILE_INVALID: soty-notary');
      const { exec, calls } = fakeExec({ identities: listing, pem });
      const result = await macosTrustPreflight(
        { ...complete, SOTY_SIGNING_KEYCHAIN: '/keys/release.keychain-db' },
        { exec }
      );
      expect(result).toMatchObject({
        policy: 'developer-id',
        checked: true,
        identity: IDENTITY,
        teamId: TEAM,
        notaryProfile: 'soty-notary'
      });
      expect(Date.parse(result.certificateExpiresAt ?? '')).toBeGreaterThan(Date.now());
      expect(calls).toEqual([
        ['security', 'find-identity', '-v', '-p', 'codesigning', '/keys/release.keychain-db'],
        ['security', 'find-certificate', '-c', IDENTITY, '-p', '/keys/release.keychain-db'],
        [
          'xcrun',
          'notarytool',
          'history',
          '--keychain-profile',
          'soty-notary',
          '--keychain',
          '/keys/release.keychain-db'
        ]
      ]);
    },
    60_000
  );
});
