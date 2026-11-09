import { outputDigest } from './release-web-meta.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseMacosTarget, macosPaths, nativeAcceptanceAllowed } from './lib/macos-target.mjs';
import {
  betaPublicConfigDigest,
  INTEL_ACCEPTANCE_POLICY,
  validateMacosBetaEvidence
} from './lib/release/platform-evidence.mjs';
import { verifyMacosPayload } from './lib/macos-payload.mjs';
import { betaPackageProvenance } from './beta-package-provenance.mjs';
const target = parseMacosTarget(process.argv.slice(2));
const cwd = process.cwd();
const paths = macosPaths(cwd, 'beta', target.arch);
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
let qualification;
if (target.arch === 'x64') {
  const inspection = await verifyMacosPayload(paths.app, target.arch);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.app], {
    stdio: 'pipe'
  });
  qualification = {
    schemaVersion: 3,
    verificationMode: 'static-cross-build',
    acceptancePolicy: INTEL_ACCEPTANCE_POLICY,
    targetArchitecture: 'x64',
    runtimeStatus: 'unverified',
    hardwareStatus: 'unverified',
    minimumOSVerification: 'load-commands-only',
    signatureIntegrity: 'verified',
    nativeFileCount: inspection.nativeFileCount
  };
} else {
  const flag = run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
  const virtualFlag = run('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present']);
  const virtualized = virtualFlag === '0' ? false : virtualFlag === '1' ? true : null;
  if (
    !nativeAcceptanceAllowed({
      platform: process.platform,
      runtimeArch: process.arch,
      targetArch: target.arch,
      virtualized,
      armHardware: flag === '1' ? true : flag === '0' ? false : null
    })
  )
    throw new Error('MACOS_NATIVE_PROOF_UNAVAILABLE');
  qualification = {
    schemaVersion: 2,
    virtualized,
    runtimeArchitecture: process.arch,
    physicalHost: flag === '1' ? 'apple-silicon' : 'intel',
    macosVersion: run('/usr/bin/sw_vers', ['-productVersion'])
  };
}
const bytes = await readFile(path.join(paths.app, 'Contents/Resources/release.json'));
const metadata = JSON.parse(bytes.toString('utf8'));
const sourceSha = run('git', ['rev-parse', 'HEAD']);
const publicConfigDigest = await betaPublicConfigDigest(cwd);
const payloadDigest = await betaPackageProvenance({ cwd, action: 'verify', arch: target.arch });
const packageDigest = createHash('sha256').update(bytes).digest('hex');
const webPayloadDigest = await outputDigest(path.join(paths.app, 'Contents/Resources/web/dist'));
const proof = {
  webPayloadDigest,
  ...qualification,
  target: target.platform,
  sourceRevision: sourceSha,
  buildId: metadata.buildId,
  packageDigest,
  packagePayloadDigest: payloadDigest,
  publicConfigDigest,
  dirty: Boolean(run('git', ['status', '--porcelain'])),
  verifiedAt: new Date().toISOString()
};
validateMacosBetaEvidence(proof, target.platform, {
  sourceSha,
  buildId: metadata.buildId,
  publicConfigDigest,
  payloadDigest,
  packageDigest,
  webPayloadDigest
});
const file = path.join(paths.root, 'verification.json');
const temporary = `${file}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await rename(temporary, file);
