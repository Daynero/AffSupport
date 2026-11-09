import { describe, it, expect } from 'vitest';
import {
  validateMacosBetaEvidence,
  validateIntelAcceptance,
  INTEL_ACCEPTANCE_CASES,
  validateWindowsEvidence
} from '../scripts/lib/release/platform-evidence.mjs';
const binding = {
  buildId: '1.3.3+79',
  sourceSha: 'a'.repeat(40),
  publicConfigDigest: 'b'.repeat(64),
  payloadDigest: 'c'.repeat(64),
  packageDigest: 'd'.repeat(64),
  webPayloadDigest: 'e'.repeat(64)
};
const proof = {
  schemaVersion: 2,
  virtualized: false,
  target: 'macos-x64',
  buildId: '1.3.3+79',
  sourceRevision: binding.sourceSha,
  publicConfigDigest: binding.publicConfigDigest,
  packagePayloadDigest: binding.payloadDigest,
  packageDigest: binding.packageDigest,
  webPayloadDigest: binding.webPayloadDigest,
  runtimeArchitecture: 'x64',
  physicalHost: 'intel',
  macosVersion: '13.6.9',
  dirty: false,
  verifiedAt: '2026-11-07T00:00:00Z'
};
describe('platform-bound release evidence', () => {
  it('accepts owner-ratified static Intel qualification without inventing native execution', () => {
    const staticProof = {
      schemaVersion: 3,
      verificationMode: 'static-cross-build',
      acceptancePolicy: 'intel-user-feedback-v1',
      target: 'macos-x64',
      targetArchitecture: 'x64',
      runtimeStatus: 'unverified',
      hardwareStatus: 'unverified',
      minimumOSVerification: 'load-commands-only',
      signatureIntegrity: 'verified',
      nativeFileCount: 11,
      sourceRevision: binding.sourceSha,
      buildId: binding.buildId,
      publicConfigDigest: binding.publicConfigDigest,
      packagePayloadDigest: binding.payloadDigest,
      packageDigest: binding.packageDigest,
      webPayloadDigest: binding.webPayloadDigest,
      dirty: false,
      verifiedAt: '2026-11-07T00:00:00Z'
    };
    expect(validateMacosBetaEvidence(staticProof, 'macos-x64', binding)).toMatchObject({
      verificationMode: 'static-cross-build',
      runtimeStatus: 'unverified'
    });
    for (const patch of [
      { acceptancePolicy: 'skip-tests' },
      { runtimeStatus: 'passed' },
      { hardwareStatus: 'passed' },
      { nativeFileCount: 0 },
      { physicalHost: 'intel' },
      { runtimeArchitecture: 'x64' },
      { virtualized: false },
      { macosVersion: '13.0' },
      { packagePayloadDigest: 'f'.repeat(64) },
      { dirty: true }
    ])
      expect(() =>
        validateMacosBetaEvidence({ ...staticProof, ...patch }, 'macos-x64', binding)
      ).toThrow();
    expect(() =>
      validateMacosBetaEvidence({ ...staticProof, target: 'macos-arm64' }, 'macos-arm64', binding)
    ).toThrow();
  });
  it('validates optional complete physical Intel reports without manufacturing observations', () => {
    const row = {
      physicalHost: 'intel',
      translated: false,
      virtualized: false,
      runtimeArchitecture: 'x64',
      sourceSha: binding.sourceSha,
      packagePayloadDigest: binding.payloadDigest,
      publicConfigDigest: binding.publicConfigDigest,
      webPayloadDigest: binding.webPayloadDigest,
      verifiedAt: '2026-11-07T00:00:00Z',
      cases: Object.fromEntries(INTEL_ACCEPTANCE_CASES.map(name => [name, 'passed']))
    };
    const matrix = {
      schemaVersion: 1,
      target: 'macos-x64',
      observations: [
        { ...row, macosVersion: '13.0' },
        { ...row, macosVersion: '15.1' }
      ]
    };
    expect(validateIntelAcceptance(matrix, binding).observations).toHaveLength(2);
    for (const patch of [
      { virtualized: true },
      { macosVersion: '13.6.9' },
      { translated: true },
      { webPayloadDigest: 'f'.repeat(64) },
      { cases: { ...row.cases, compression: 'unknown' } }
    ])
      expect(() =>
        validateIntelAcceptance(
          {
            ...matrix,
            observations: [{ ...matrix.observations[0], ...patch }, matrix.observations[1]]
          },
          binding
        )
      ).toThrow();
    expect(() =>
      validateIntelAcceptance({ ...matrix, observations: matrix.observations.slice(1) }, binding)
    ).toThrow();
  });
  it('accepts exact native proof, refuses substitution and unknown identity', () => {
    expect(() => validateMacosBetaEvidence(proof, 'macos-x64', binding)).not.toThrow();
    for (const patch of [
      { target: 'macos-arm64' },
      { buildId: '1.3.3+80' },
      { virtualized: true },
      { virtualized: null },
      { webPayloadDigest: 'f'.repeat(64) },
      { verifiedAt: 'yesterday' },
      { runtimeArchitecture: 'arm64' },
      { physicalHost: 'apple-silicon' },
      { physicalHost: 'unknown' },
      { sourceRevision: 'e'.repeat(40) },
      { publicConfigDigest: 'f'.repeat(64) },
      { packagePayloadDigest: 'f'.repeat(64) },
      { dirty: true },
      { macosVersion: '12.7' }
    ])
      expect(() =>
        validateMacosBetaEvidence({ ...proof, ...patch }, 'macos-x64', binding)
      ).toThrow();
  });
  it('requires source-bound smoke and final Windows bytes', () => {
    const good = {
      schemaVersion: 1,
      sourceSha: binding.sourceSha,
      installerSha256: 'a'.repeat(64),
      validation: 'passed',
      installUseUninstall: 'passed',
      productionPackage: 'passed',
      workflowRunId: '123',
      smokeInstallerSha256: 'b'.repeat(64),
      verifiedAt: '2026-11-07T00:00:00Z'
    };
    expect(() =>
      validateWindowsEvidence(good, {
        sourceSha: binding.sourceSha,
        installerSha256: 'a'.repeat(64)
      })
    ).not.toThrow();
    expect(() =>
      validateWindowsEvidence(
        { ...good, sourceSha: 'b'.repeat(40) },
        { sourceSha: binding.sourceSha, installerSha256: 'a'.repeat(64) }
      )
    ).toThrow();
    expect(() =>
      validateWindowsEvidence(
        { ...good, installUseUninstall: 'unknown' },
        { sourceSha: binding.sourceSha, installerSha256: 'a'.repeat(64) }
      )
    ).toThrow();
  });
});
