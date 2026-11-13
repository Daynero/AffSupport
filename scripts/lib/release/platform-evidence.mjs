import { outputDigest } from '../../release-web-meta.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { macosPaths, macosTarget } from '../macos-target.mjs';
import { packagePayloadDigest } from '../web-only-proof.mjs';
export async function readEvidenceJSON(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 32768) throw new Error('PLATFORM_EVIDENCE_SIZE_INVALID');
  return JSON.parse(await readFile(file, 'utf8'));
}
const validIso = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
export const INTEL_ACCEPTANCE_POLICY = 'intel-user-feedback-v1';
const DIGEST = /^[a-f0-9]{64}$/u;
export const INTEL_ACCEPTANCE_CASES = [
  'auth-entitlement',
  'compression',
  'stitch-restitch',
  'transcription-fast',
  'transcription-accurate',
  'landing-preview',
  'landing-optimization',
  'team-background-render',
  'finder',
  'cancel',
  'power-20',
  'power-100',
  'retained-data',
  'single-instance'
];
export async function betaPublicConfigDigest(cwd) {
  const text = await readFile(path.join(cwd, '.env.beta'), 'utf8');
  const keys = [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'AGENT_ENTITLEMENT_PUBLIC_KEY',
    'VITE_TEAM_DIRECT_ADD_MODE',
    'VITE_GOOGLE_PICKER_API_KEY',
    'VITE_GOOGLE_PROJECT_NUMBER'
  ];
  const values = Object.fromEntries(
    keys.map(key => [
      key,
      text
        .split(/\r?\n/u)
        .find(line => line.startsWith(`${key}=`))
        ?.slice(key.length + 1) ?? ''
    ])
  );
  if (
    !values.VITE_SUPABASE_URL.startsWith('http://127.0.0.1:') ||
    !values.AGENT_ENTITLEMENT_PUBLIC_KEY
  )
    throw new Error('BETA_PUBLIC_CONFIG_UNPROVEN');
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
/** Intel static qualification is owner-ratified; it never claims native execution. */
export function macosEvidenceQualification(proof) {
  return proof.schemaVersion === 3
    ? { verificationMode: 'static-cross-build', acceptancePolicy: INTEL_ACCEPTANCE_POLICY }
    : { verificationMode: 'native-runtime' };
}
export function validateMacosBetaEvidence(proof, target, binding) {
  const arch = macosTarget(target === 'macos-x64' ? 'x64' : 'arm64').arch;
  if (!['macos-arm64', 'macos-x64'].includes(target) ||
      ![2, 3].includes(proof?.schemaVersion) || proof.target !== target ||
      !/^[a-f0-9]{40}$/u.test(binding.sourceSha ?? '') || proof.dirty !== false ||
      !validIso(proof.verifiedAt) || typeof proof.buildId !== 'string' ||
      !/^[A-Za-z0-9.+-]{1,128}$/u.test(proof.buildId))
    throw new Error('MACOS_BETA_TARGET_UNPROVEN');
  if (proof.schemaVersion === 3) {
    if (target !== 'macos-x64' || proof.verificationMode !== 'static-cross-build' ||
        proof.acceptancePolicy !== INTEL_ACCEPTANCE_POLICY || proof.targetArchitecture !== 'x64' ||
        proof.runtimeStatus !== 'unverified' || proof.hardwareStatus !== 'unverified' ||
        proof.minimumOSVerification !== 'load-commands-only' || proof.signatureIntegrity !== 'verified' ||
        !Number.isSafeInteger(proof.nativeFileCount) || proof.nativeFileCount < 6 || proof.nativeFileCount > 1024 ||
        ['runtimeArchitecture', 'physicalHost', 'macosVersion', 'virtualized'].some(key => key in proof))
      throw new Error('MACOS_INTEL_STATIC_UNPROVEN');
  } else if (proof.virtualized !== false || proof.runtimeArchitecture !== arch ||
      proof.physicalHost !== (arch === 'x64' ? 'intel' : 'apple-silicon') ||
      !/^\d+\.\d+(?:\.\d+)?$/u.test(proof.macosVersion ?? '') || Number(proof.macosVersion.split('.')[0]) < 13)
    throw new Error('MACOS_BETA_TARGET_UNPROVEN');
  // 048 FR-008 (T008): the proof records the chain's work — every Mach-O hardened, the
  // runtime alone on the JIT profile — not only that some signature verified.
  const signing = proof.codeSigning;
  if (
    !signing || typeof signing !== 'object' || signing.chain !== 'sign-mac-app' ||
    !['adhoc', 'developer-id'].includes(signing.identity) ||
    !Number.isSafeInteger(signing.hardenedMachO) || signing.hardenedMachO < 3 || signing.hardenedMachO > 1024 ||
    !Number.isSafeInteger(signing.machO) || signing.machO < 1 || signing.machO > signing.hardenedMachO ||
    !signing.profiles || typeof signing.profiles !== 'object' ||
    !['node', 'chromium', 'hardened'].every(name => Number.isSafeInteger(signing.profiles[name]) && signing.profiles[name] >= 0) ||
    signing.profiles.node !== 1
  )
    throw new Error('MACOS_BETA_SIGNING_UNPROVEN');
  if (proof.buildId !== binding.buildId) throw new Error('MACOS_BETA_BUILD_MISMATCH');
  for (const [field, expected] of Object.entries({
    sourceRevision: binding.sourceSha,
    publicConfigDigest: binding.publicConfigDigest,
    packagePayloadDigest: binding.payloadDigest,
    packageDigest: binding.packageDigest,
    webPayloadDigest: binding.webPayloadDigest
  }))
    if (
      proof[field] !== expected ||
      !expected ||
      (field !== 'sourceRevision' && !DIGEST.test(expected))
    )
      throw new Error('MACOS_BETA_BINDING_MISMATCH');
  const qualification = proof.schemaVersion === 3 ? {
    ...macosEvidenceQualification(proof), targetArchitecture: 'x64',
    runtimeStatus: 'unverified', hardwareStatus: 'unverified',
    minimumOSVerification: 'load-commands-only', signatureIntegrity: 'verified', nativeFileCount: proof.nativeFileCount
  } : {
    runtimeArchitecture: arch, physicalHost: proof.physicalHost, virtualized: false, macosVersion: proof.macosVersion
  };
  return {
    schemaVersion: proof.schemaVersion,
    ...qualification,
    codeSigning: {
      chain: 'sign-mac-app',
      identity: signing.identity,
      hardenedMachO: signing.hardenedMachO,
      machO: signing.machO,
      profiles: {
        node: signing.profiles.node,
        chromium: signing.profiles.chromium,
        hardened: signing.profiles.hardened
      }
    },
    target,
    sourceRevision: proof.sourceRevision,
    buildId: proof.buildId,
    publicConfigDigest: proof.publicConfigDigest,
    packagePayloadDigest: proof.packagePayloadDigest,
    packageDigest: proof.packageDigest,
    webPayloadDigest: proof.webPayloadDigest,
    dirty: false,
    verifiedAt: proof.verifiedAt
  };
}
export function validateIntelAcceptance(matrix, binding) {
  if (
    matrix?.schemaVersion !== 1 ||
    matrix.target !== 'macos-x64' ||
    !Array.isArray(matrix.observations) ||
    matrix.observations.length > 8
  )
    throw new Error('INTEL_HARDWARE_ACCEPTANCE_MISSING');
  const accepted = [];
  for (const major of [13, 'newer']) {
    const observation = matrix.observations.find(
      row =>
        row.physicalHost === 'intel' &&
        row.translated === false &&
        row.virtualized === false &&
        row.runtimeArchitecture === 'x64' &&
        /^\d+\.\d+(?:\.\d+)?$/u.test(row.macosVersion ?? '') &&
        (major === 'newer'
          ? Number(row.macosVersion.split('.')[0]) > 13
          : Number(row.macosVersion.split('.')[0]) === 13 &&
            Number(row.macosVersion.split('.')[1]) === 0) &&
        row.sourceSha === binding.sourceSha &&
        row.packagePayloadDigest === binding.payloadDigest &&
        row.publicConfigDigest === binding.publicConfigDigest &&
        row.webPayloadDigest === binding.webPayloadDigest &&
        validIso(row.verifiedAt) &&
        INTEL_ACCEPTANCE_CASES.every(name => row.cases?.[name] === 'passed')
    );
    if (!observation) throw new Error('INTEL_HARDWARE_ACCEPTANCE_INCOMPLETE');
    accepted.push({
      physicalHost: 'intel',
      translated: false,
      virtualized: false,
      runtimeArchitecture: 'x64',
      macosVersion: observation.macosVersion,
      sourceSha: binding.sourceSha,
      packagePayloadDigest: binding.payloadDigest,
      publicConfigDigest: binding.publicConfigDigest,
      webPayloadDigest: binding.webPayloadDigest,
      verifiedAt: observation.verifiedAt,
      cases: Object.fromEntries(INTEL_ACCEPTANCE_CASES.map(name => [name, 'passed']))
    });
  }
  return { schemaVersion: 1, target: 'macos-x64', observations: accepted };
}
export function validateWindowsEvidence(proof, binding) {
  if (
    proof?.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/u.test(binding.sourceSha ?? '') ||
    !DIGEST.test(proof.smokeInstallerSha256 ?? '') ||
    !validIso(proof.verifiedAt) ||
    proof.sourceSha !== binding.sourceSha ||
    proof.installerSha256 !== binding.installerSha256 ||
    !DIGEST.test(proof.installerSha256 ?? '') ||
    !/^\d{1,32}$/u.test(proof.workflowRunId ?? '') ||
    ['validation', 'installUseUninstall', 'productionPackage'].some(key => proof[key] !== 'passed')
  )
    throw new Error('WINDOWS_RELEASE_EVIDENCE_UNPROVEN');
  return {
    schemaVersion: 1,
    sourceSha: proof.sourceSha,
    installerSha256: proof.installerSha256,
    smokeInstallerSha256: proof.smokeInstallerSha256,
    workflowRunId: proof.workflowRunId,
    validation: 'passed',
    installUseUninstall: 'passed',
    productionPackage: 'passed',
    verifiedAt: proof.verifiedAt
  };
}
export async function assertMacosBetaEvidence(cwd, target, { sourceSha }) {
  const arch = target === 'macos-x64' ? 'x64' : 'arm64';
  const paths = macosPaths(cwd, 'beta', arch);
  const bytes = await readFile(path.join(paths.app, 'Contents/Resources/release.json'));
  const metadata = JSON.parse(bytes.toString('utf8'));
  const binding = {
    sourceSha,
    buildId: metadata.buildId,
    publicConfigDigest: await betaPublicConfigDigest(cwd),
    payloadDigest: await packagePayloadDigest(paths.app),
    packageDigest: createHash('sha256').update(bytes).digest('hex'),
    webPayloadDigest: await outputDigest(path.join(paths.app, 'Contents/Resources/web/dist'))
  };
  if (
    !/^[a-f0-9]{40}$/u.test(metadata.sourceRevision ?? '') ||
    !/^[a-f0-9]{40}$/u.test(sourceSha ?? '')
  )
    throw new Error('MACOS_BETA_SOURCE_INVALID');
  if (metadata.sourceRevision !== sourceSha) {
    execFileSync('git', ['merge-base', '--is-ancestor', metadata.sourceRevision, sourceSha], {
      cwd,
      stdio: 'pipe'
    });
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', metadata.sourceRevision, sourceSha],
      { cwd, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (changed.some(file => file !== 'apps/web/public/.well-known/wishly/stable.json'))
      throw new Error('MACOS_BETA_SOURCE_CHANGED');
  }
  if (metadata.target !== target || metadata.architecture !== arch || metadata.channel !== 'beta')
    throw new Error('MACOS_BETA_PACKAGE_MISMATCH');
  const provenance = await readEvidenceJSON(path.join(paths.root, 'package-provenance.json'));
  if (
    provenance.target !== target ||
    provenance.dirty !== false ||
    provenance.sourceRevision !== metadata.sourceRevision ||
    provenance.payloadDigest !== binding.payloadDigest ||
    provenance.publicConfigDigest !== binding.publicConfigDigest ||
    provenance.webPayloadDigest !== binding.webPayloadDigest
  )
    throw new Error('MACOS_BETA_PROVENANCE_MISMATCH');
  const proof = validateMacosBetaEvidence(
    await readEvidenceJSON(path.join(paths.root, 'verification.json')),
    target,
    binding
  );
  return proof;
}
