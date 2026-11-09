import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSigningMatchesPolicy,
  lastJsonObjectLine,
  parseSigningSummary,
  parseTrustRecord,
  readSigningSummary
} from '../scripts/lib/macos-signing-summary.mjs';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * 048 T013. The chain's `signing.json` and the gate's trust record cross a process
 * boundary into the release runner; this is the closed shape each must have, and the
 * one rule that ties them to the policy the owner chose.
 */

const adhoc = {
  app: '/build/release/Soty.app',
  identity: 'adhoc',
  teamId: null,
  machO: 10,
  nestedBundles: 1,
  profiles: { node: 1, chromium: 1, hardened: 7 },
  notarized: false,
  stapled: false,
  submissionId: null
};
const developerId = {
  ...adhoc,
  identity: 'developer-id',
  teamId: 'ABCDEFGHIJ',
  notarized: true,
  stapled: true,
  submissionId: '0b1f1e1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b'
};
const unverified = {
  target: 'macos-arm64',
  trustPolicy: 'adhoc-pre-048',
  appleTrust: 'unverified',
  developerId: false,
  notarized: false,
  stapled: false
};
const verified = {
  target: 'macos-arm64',
  trustPolicy: 'developer-id',
  appleTrust: 'verified',
  developerId: true,
  hardenedMachO: 11,
  notarized: true,
  stapled: true
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

describe('the signing summary beside a Mac package', () => {
  it('accepts the two shapes the chain prints and nothing looser', () => {
    expect(parseSigningSummary(adhoc)).toEqual({ ok: true, value: adhoc });
    expect(parseSigningSummary(developerId)).toEqual({ ok: true, value: developerId });
    // A chain older than T017 printed no submissionId; that still reads as "none".
    const withoutSubmission = Object.fromEntries(
      Object.entries(adhoc).filter(([key]) => key !== 'submissionId')
    );
    expect(parseSigningSummary(withoutSubmission)).toMatchObject({ ok: true });
    for (const [broken, error] of [
      [null, 'SIGNING_SUMMARY_INVALID'],
      [{ ...adhoc, app: '/build/release/Soty.zip' }, 'SIGNING_SUMMARY_APP_INVALID'],
      [{ ...adhoc, identity: 'self-signed' }, 'SIGNING_SUMMARY_IDENTITY_INVALID'],
      [{ ...adhoc, teamId: 'ABCDEFGHIJ' }, 'SIGNING_SUMMARY_TEAM_INVALID'],
      [{ ...developerId, teamId: null }, 'SIGNING_SUMMARY_TEAM_INVALID'],
      [{ ...adhoc, machO: 9 }, 'SIGNING_SUMMARY_COUNT_INVALID'],
      [{ ...adhoc, profiles: { node: 1, chromium: 1 } }, 'SIGNING_SUMMARY_PROFILES_INVALID'],
      [{ ...adhoc, notarized: 'yes' }, 'SIGNING_SUMMARY_FLAGS_INVALID'],
      [
        { ...adhoc, notarized: true, submissionId: developerId.submissionId },
        'SIGNING_SUMMARY_ADHOC_NOTARIZED'
      ],
      [
        { ...developerId, stapled: true, notarized: false, submissionId: null },
        'SIGNING_SUMMARY_FLAGS_INVALID'
      ],
      [{ ...developerId, submissionId: 'receipt' }, 'SIGNING_SUMMARY_SUBMISSION_INVALID'],
      [{ ...developerId, submissionId: null }, 'SIGNING_SUMMARY_SUBMISSION_INVALID']
    ] as const)
      expect(parseSigningSummary(broken)).toEqual({ ok: false, error });
  });

  it('tells a missing file from an unusable one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-signing-summary-'));
    directories.push(root);
    expect(await readSigningSummary(path.join(root, 'signing.json'))).toEqual({
      ok: false,
      error: 'SIGNING_SUMMARY_MISSING'
    });
    await writeFile(path.join(root, 'signing.json'), '{not json');
    expect(await readSigningSummary(path.join(root, 'signing.json'))).toEqual({
      ok: false,
      error: 'SIGNING_SUMMARY_INVALID'
    });
    await writeFile(path.join(root, 'signing.json'), `${JSON.stringify(developerId)}\n`);
    expect(await readSigningSummary(path.join(root, 'signing.json'))).toEqual({
      ok: true,
      value: developerId
    });
  });
});

describe('the release gate record', () => {
  it('lets each policy claim exactly what it verified', () => {
    expect(parseTrustRecord(unverified)).toEqual({ ok: true, value: unverified });
    expect(parseTrustRecord(verified)).toEqual({ ok: true, value: verified });
    for (const [broken, error] of [
      ['{}', 'TRUST_RECORD_INVALID'],
      [{ ...unverified, target: 'macos-universal' }, 'TRUST_RECORD_TARGET_INVALID'],
      [{ ...unverified, trustPolicy: 'adhoc' }, 'TRUST_RECORD_POLICY_INVALID'],
      [{ ...unverified, notarized: true }, 'TRUST_RECORD_ADHOC_OVERCLAIMS'],
      [{ ...unverified, hardenedMachO: 11 }, 'TRUST_RECORD_ADHOC_OVERCLAIMS'],
      [{ ...verified, stapled: false }, 'TRUST_RECORD_DEVELOPER_ID_INCOMPLETE'],
      [{ ...verified, hardenedMachO: 0 }, 'TRUST_RECORD_DEVELOPER_ID_INCOMPLETE']
    ] as const)
      expect(parseTrustRecord(broken)).toEqual({ ok: false, error });
  });

  it('is read from the last JSON line of the gate output, after codesign noise', () => {
    expect(
      lastJsonObjectLine([
        'Executable=/Volumes/Soty/Soty.app\n',
        'warning: x\n',
        `${JSON.stringify(verified)}\n`
      ])
    ).toEqual(verified);
    expect(lastJsonObjectLine(['nothing here\n'])).toBeNull();
    expect(lastJsonObjectLine(['{torn\n'])).toBeNull();
  });
});

describe('policy against the summary (048 FR-005)', () => {
  const ok = (value: typeof adhoc | typeof developerId) => ({ ok: true as const, value });
  const missing = { ok: false as const, error: 'SIGNING_SUMMARY_MISSING' };

  it('under developer-id requires a notarized Developer ID summary from the expected team', () => {
    expect(() => assertSigningMatchesPolicy(ok(developerId), verified, 'ABCDEFGHIJ')).not.toThrow();
    expect(() => assertSigningMatchesPolicy(missing, verified, 'ABCDEFGHIJ')).toThrow(
      'MACOS_SIGNING_SUMMARY_REQUIRED: SIGNING_SUMMARY_MISSING'
    );
    expect(() => assertSigningMatchesPolicy(ok(adhoc), verified, 'ABCDEFGHIJ')).toThrow(
      'MACOS_SIGNING_IDENTITY_ADHOC'
    );
    expect(() => assertSigningMatchesPolicy(ok(developerId), verified, 'ZZZZZZZZZZ')).toThrow(
      'MACOS_SIGNING_TEAM_MISMATCH'
    );
    expect(() => assertSigningMatchesPolicy(ok(developerId), verified, undefined)).toThrow(
      'MACOS_SIGNING_TEAM_MISMATCH'
    );
    expect(() =>
      assertSigningMatchesPolicy(
        ok({ ...developerId, notarized: false, stapled: false, submissionId: null }),
        verified,
        'ABCDEFGHIJ'
      )
    ).toThrow('MACOS_SIGNING_NOT_NOTARIZED');
  });

  it('under adhoc-pre-048 tolerates no summary but not a summary that contradicts the policy', () => {
    expect(() => assertSigningMatchesPolicy(missing, unverified, undefined)).not.toThrow();
    expect(() => assertSigningMatchesPolicy(ok(adhoc), unverified, undefined)).not.toThrow();
    expect(() => assertSigningMatchesPolicy(ok(developerId), unverified, 'ABCDEFGHIJ')).toThrow(
      'MACOS_SIGNING_POLICY_CONFLICT'
    );
  });
});
