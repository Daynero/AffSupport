import { describe, expect, it } from 'vitest';
import {
  assertMacosPackageIdentity,
  assertMacosSigner,
  macosTrustPolicy,
  verifyMacosReleaseTrust
} from '../scripts/verify-macos-release-trust.mjs';
describe('Apple trust integration boundary', () => {
  it('requires a hardened Developer ID signature from the pinned owner team', () => {
    const details =
      'Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20500 size=200 flags=0x10000(runtime)';
    expect(() => assertMacosSigner(details, 'ABCDEFGHIJ')).not.toThrow();
    for (const invalid of [
      details.replace('ABCDEFGHIJ', 'ZZZZZZZZZZ'),
      details.replace('ABCDEFGHIJ', 'ABCDEFGHIJEXTRA'),
      details.replace('Authority=Developer ID Application: Fixture', 'Signature=adhoc'),
      details.replace('runtime', 'none')
    ])
      expect(() => assertMacosSigner(invalid, 'ABCDEFGHIJ')).toThrow();
  });

  it('defaults to Developer ID and accepts only the named pre-048 policy as an alternative', () => {
    expect(macosTrustPolicy(undefined)).toBe('developer-id');
    expect(macosTrustPolicy('')).toBe('developer-id');
    expect(macosTrustPolicy('adhoc-pre-048')).toBe('adhoc-pre-048');
    for (const invalid of ['adhoc', 'none', 'skip', 'Developer-ID'])
      expect(() => macosTrustPolicy(invalid)).toThrow('MACOS_TRUST_POLICY_INVALID');
  });

  it('refuses a Developer ID release without the expected team before touching the image', async () => {
    await expect(
      verifyMacosReleaseTrust('/nonexistent/Soty.dmg', 'x64', undefined)
    ).rejects.toThrow('MACOS_EXPECTED_TEAM_ID_REQUIRED');
  });

  it('binds the sealed package metadata to its target, build and stable channel', () => {
    const intel = {
      target: 'macos-x64',
      architecture: 'x64',
      buildId: '1.3.4+80',
      channel: 'stable'
    };
    expect(() => assertMacosPackageIdentity(intel, 'x64', '1.3.4+80')).not.toThrow();
    for (const invalid of [
      { ...intel, target: 'macos-arm64' },
      { ...intel, architecture: 'arm64' },
      { ...intel, buildId: '1.3.3+79' },
      { ...intel, channel: 'beta' },
      { buildId: '1.3.4+80', channel: 'stable' }
    ])
      expect(() => assertMacosPackageIdentity(invalid, 'x64', '1.3.4+80')).toThrow(
        'MACOS_PACKAGE_IDENTITY_MISMATCH'
      );
    // An ARM package can never satisfy the Intel slot.
    expect(() =>
      assertMacosPackageIdentity(
        { ...intel, target: 'macos-arm64', architecture: 'arm64' },
        'x64',
        '1.3.4+80'
      )
    ).toThrow();
  });
});
