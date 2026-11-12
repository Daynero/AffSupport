import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertMacosBetaEvidence,
  macosEvidenceQualification,
  INTEL_ACCEPTANCE_POLICY,
  validateWindowsEvidence,
  readEvidenceJSON
} from './platform-evidence.mjs';
import { valueDigest } from '../web-only-proof.mjs';
const FILE = 'release/beta/platform-baseline.json';
const manifestFile = 'apps/web/public/.well-known/wishly/stable.json';
function assertWindowsSource(cwd, sourceSha, windows) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? '') || !/^[a-f0-9]{40}$/u.test(windows?.sourceSha ?? ''))
    throw new Error('WINDOWS_BASELINE_SOURCE_INVALID');
  if (windows.sourceSha !== sourceSha) {
    execFileSync('git', ['merge-base', '--is-ancestor', windows.sourceSha, sourceSha], {
      cwd,
      stdio: 'pipe'
    });
    const files = execFileSync('git', ['diff', '--name-only', windows.sourceSha, sourceSha], {
      cwd,
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (files.some(file => file !== manifestFile))
      throw new Error('WINDOWS_BASELINE_SOURCE_CHANGED');
  }
}
export async function writePlatformBaseline(cwd, sourceSha, windows, { macosTrust = {} } = {}) {
  assertWindowsSource(cwd, sourceSha, windows);
  const channelBytes = await readFile(path.join(cwd, manifestFile));
  const channel = JSON.parse(channelBytes.toString('utf8'));
  validateWindowsEvidence(windows, {
    sourceSha: windows.sourceSha,
    installerSha256: channel.artifacts?.['windows-x64']?.sha256
  });
  const macos = {};
  for (const target of ['macos-arm64', 'macos-x64']) {
    const proof = await assertMacosBetaEvidence(cwd, target, { sourceSha });
    macos[target] = {
      ...macosEvidenceQualification(proof),
      sourceSha,
      payloadDigest: proof.packagePayloadDigest,
      webPayloadDigest: proof.webPayloadDigest,
      proofDigest: valueDigest(proof),
      // 048 T013: how publish found the artifact signed, beside how beta found it built.
      ...(macosTrust[target]
        ? { trust: macosTrust[target].trust, signing: macosTrust[target].signing }
        : {})
    };
  }
  const baseline = {
    schemaVersion: 1,
    sourceSha,
    signedChannelDigest: createHash('sha256').update(channelBytes).digest('hex'),
    macos,
    windows: {
      schemaVersion: 1,
      sourceSha: windows.sourceSha,
      installerSha256: windows.installerSha256,
      smokeInstallerSha256: windows.smokeInstallerSha256,
      workflowRunId: windows.workflowRunId,
      validation: windows.validation,
      installUseUninstall: windows.installUseUninstall,
      productionPackage: windows.productionPackage,
      verifiedAt: windows.verifiedAt
    }
  };
  const file = path.join(cwd, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return baseline;
}
export async function assertPlatformBaseline(cwd, channelBytes, platformBaselines) {
  const baseline = await readEvidenceJSON(path.join(cwd, FILE));
  const channel = JSON.parse(Buffer.from(channelBytes).toString('utf8'));
  if (
    baseline.schemaVersion !== 1 ||
    baseline.signedChannelDigest !== createHash('sha256').update(channelBytes).digest('hex') ||
    !/^([a-f0-9]{40})$/u.test(baseline.sourceSha ?? '')
  )
    throw new Error('PLATFORM_BASELINE_CHANNEL_MISMATCH');
  for (const proof of platformBaselines) {
    const expected = baseline.macos?.[proof.target];
    if (
      !expected ||
      (expected.verificationMode ?? 'native-runtime') !== (proof.verificationMode ?? 'native-runtime') ||
      expected.acceptancePolicy !== proof.acceptancePolicy ||
      (proof.verificationMode === 'static-cross-build' &&
        (proof.target !== 'macos-x64' || proof.acceptancePolicy !== INTEL_ACCEPTANCE_POLICY)) ||
      expected.sourceSha !== proof.sourceSha ||
      expected.payloadDigest !== proof.payloadDigest ||
      expected.webPayloadDigest !== proof.webPayloadDigest ||
      expected.proofDigest !== proof.proofDigest
    )
      throw new Error('PLATFORM_BASELINE_TARGET_MISMATCH');
  }
  if (
    platformBaselines.length !== 2 ||
    new Set(platformBaselines.map(proof => proof.target)).size !== 2 ||
    platformBaselines.some(
      proof =>
        !['macos-arm64', 'macos-x64'].includes(proof.target) ||
        proof.sourceSha !== baseline.sourceSha
    )
  )
    throw new Error('PLATFORM_BASELINE_INCOMPLETE');
  assertWindowsSource(cwd, baseline.sourceSha, baseline.windows);
  validateWindowsEvidence(baseline.windows, {
    sourceSha: baseline.windows.sourceSha,
    installerSha256: channel.artifacts?.['windows-x64']?.sha256
  });
  return valueDigest(baseline);
}
