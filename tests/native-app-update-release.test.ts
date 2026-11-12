import { describe, expect, it } from 'vitest';
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
