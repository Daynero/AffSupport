import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { promisify } from 'node:util';
import { macosTrustPolicy } from '../../verify-macos-release-trust.mjs';

const execFileAsync = promisify(execFile);
const TEAM_ID = /^[A-Z0-9]{10}$/u;

/**
 * 048 FR-006 / T019. Proves, before the first heavy packaging step, the inputs a
 * `developer-id` release needs at its end: the signing identity is present and
 * currently valid in a keychain, its certificate names the expected team and has not
 * expired, and the notary profile answers Apple. A release without a certificate still
 * runs, but only when the owner says so with `SOTY_MACOS_TRUST_POLICY=adhoc-pre-048`;
 * there is no silent fallback. Every refusal is a closed code at the front of the
 * error message. Nothing is signed or submitted here.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ exec?: typeof execFileAsync, now?: () => number }} [options]
 */
export async function macosTrustPreflight(
  env,
  { exec = execFileAsync, now = () => Date.now() } = {}
) {
  const policy = macosTrustPolicy(env.SOTY_MACOS_TRUST_POLICY);
  if (policy === 'adhoc-pre-048') return { policy, checked: false };
  const identity = env.SOTY_SIGNING_IDENTITY?.trim() ?? '';
  const team = env.MACOS_EXPECTED_TEAM_ID?.trim() ?? '';
  const profile = env.SOTY_NOTARY_KEYCHAIN_PROFILE?.trim() ?? '';
  const keychain = env.SOTY_SIGNING_KEYCHAIN?.trim() ?? '';
  const missing = [];
  if (!identity || identity === '-') missing.push('SOTY_SIGNING_IDENTITY');
  if (!TEAM_ID.test(team)) missing.push('MACOS_EXPECTED_TEAM_ID');
  if (!profile) missing.push('SOTY_NOTARY_KEYCHAIN_PROFILE');
  if (missing.length) throw new Error(`MACOS_TRUST_INPUTS_MISSING: ${missing.join(', ')}`);
  const keychainArgs = keychain ? [keychain] : [];
  // `-v` lists only identities whose certificate is valid right now.
  const identities = await exec('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
    ...keychainArgs
  ]).then(
    ({ stdout }) => stdout,
    () => {
      throw new Error('MACOS_TRUST_KEYCHAIN_UNAVAILABLE');
    }
  );
  if (!identities.split(/\r?\n/u).some(line => line.includes(`"${identity}"`)))
    throw new Error(`MACOS_TRUST_IDENTITY_MISSING: ${identity}`);
  const pem = await exec('security', ['find-certificate', '-c', identity, '-p', ...keychainArgs]).then(
    ({ stdout }) => stdout,
    () => {
      throw new Error('MACOS_TRUST_IDENTITY_MISSING: certificate unreadable');
    }
  );
  const begin = pem.indexOf('-----BEGIN CERTIFICATE-----');
  if (begin < 0) throw new Error('MACOS_TRUST_IDENTITY_MISSING: certificate unreadable');
  const certificate = new X509Certificate(pem.slice(begin));
  // Apple puts the Team ID in the certificate's OU; the name in parentheses is only a label.
  const certificateTeam = /^OU=(.+)$/mu.exec(certificate.subject)?.[1]?.trim();
  if (certificateTeam !== team)
    throw new Error(
      `MACOS_TRUST_TEAM_MISMATCH: certificate team ${certificateTeam ?? 'unknown'}, expected ${team}`
    );
  const expiresAt = Date.parse(certificate.validTo);
  if (!Number.isFinite(expiresAt) || expiresAt <= now())
    throw new Error(`MACOS_TRUST_IDENTITY_EXPIRED: ${certificate.validTo}`);
  await exec('xcrun', [
    'notarytool',
    'history',
    '--keychain-profile',
    profile,
    ...(keychain ? ['--keychain', keychain] : [])
  ]).catch(() => {
    throw new Error(`MACOS_TRUST_NOTARY_PROFILE_INVALID: ${profile}`);
  });
  return {
    policy,
    checked: true,
    identity,
    teamId: team,
    notaryProfile: profile,
    certificateExpiresAt: new Date(expiresAt).toISOString()
  };
}
