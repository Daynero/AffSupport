import { readFile } from 'node:fs/promises';
import { SPARKLE } from './native-update-sdk.mjs';
export const NATIVE_UPDATE_QUALIFICATION_CASES = Object.freeze([
  'preconsent-quit',
  'preconsent-crash',
  'tampered-manifest',
  'tampered-archive',
  'wrong-target',
  'wrong-publisher',
  'stale-consent',
  'lost-accept-reply',
  'active-compressor',
  'active-transcription',
  'active-stitcher',
  'active-landing',
  'active-transfer',
  'waiting-attach',
  'recovery-claim',
  'preflight-race',
  'defer-before-commit',
  'flush-failure',
  'disk-full',
  'os-refusal',
  'crash-after-commit',
  'crash-during-replacement',
  'target-readiness-failure',
  'old-runtime-on-port',
  'native-ready-no-browser',
  'late-journal',
  'ui-visible',
  'helper-budget-20',
  'helper-budget-100',
  'successive-a-b-c',
  'windows-fallback'
]);
/** A package cannot enable the adapter on an unqualified source/configuration. */
export function assertNativeUpdateQualification(value, sourceSha) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.sourceSha !== sourceSha ||
    value.sdkSha256 !== SPARKLE.sha256 ||
    value.kind !== 'native-update-qualification' ||
    !Array.isArray(value.targets) ||
    !['macos-arm64', 'macos-x64'].every(target => value.targets.includes(target)) ||
    !Array.isArray(value.cases) ||
    !NATIVE_UPDATE_QUALIFICATION_CASES.every(name =>
      value.cases.some(
        entry =>
          entry.name === name &&
          entry.status === 'passed' &&
          /^[a-f0-9]{64}$/u.test(entry.evidenceSha256 ?? '')
      )
    ) ||
    !Array.isArray(value.latencySamples) ||
    value.latencySamples.length < 20 ||
    value.latencySamples.some(
      sample =>
        !Number.isFinite(sample.readyMs) ||
        sample.readyMs < 0 ||
        !Number.isFinite(sample.workMs) ||
        sample.workMs < 0 ||
        !Number.isFinite(sample.osConsentMs) ||
        sample.osConsentMs < 0 ||
        !Number.isFinite(sample.downloadMs) ||
        sample.downloadMs < 0
    ) ||
    !Array.isArray(value.trust) ||
    !['macos-arm64', 'macos-x64'].every(target =>
      value.trust.some(
        proof =>
          proof.target === target &&
          proof.developerId &&
          proof.notarized &&
          proof.stapled &&
          /^[a-f0-9]{64}$/u.test(proof.packageSha256 ?? '')
      )
    )
  )
    throw new Error('NATIVE_UPDATE_QUALIFICATION_REQUIRED');
  const controlled = value.latencySamples.map(sample => sample.readyMs).sort((a, b) => a - b);
  if (controlled[Math.ceil(controlled.length * 0.95) - 1] > 60000)
    throw new Error('NATIVE_UPDATE_LATENCY_TARGET');
  // Native Intel execution is deliberately separate from owner-ratified static
  // target qualification. The record must say which form was actually observed.
  if (!['native', 'static-intel-user-feedback-v1'].includes(value.intelEvidence))
    throw new Error('NATIVE_UPDATE_INTEL_EVIDENCE_REQUIRED');
  return value;
}
export async function readNativeUpdateQualification(file, sourceSha) {
  if (!file) throw new Error('NATIVE_UPDATE_QUALIFICATION_REQUIRED');
  const bytes = await readFile(file);
  if (bytes.length > 262144) throw new Error('NATIVE_UPDATE_QUALIFICATION_INVALID');
  return assertNativeUpdateQualification(JSON.parse(bytes.toString('utf8')), sourceSha);
}
