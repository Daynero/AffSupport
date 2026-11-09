import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMacosTarget } from './lib/macos-target.mjs';
import { verifyMacosPayload } from './lib/macos-payload.mjs';
import { BUILD_ID } from '../packages/shared/dist/release.js';

/**
 * Explicit, named policies; never inferred from the environment's absence.
 * `developer-id` (default) is the 048 public-trust gate. `adhoc-pre-048` is the
 * owner-selectable pre-048 distribution (how every release up to 1.3.3 shipped):
 * static target/payload, ad-hoc signature integrity and package identity only, and
 * the result says Apple trust is unverified. It never reports notarization.
 */
export const MACOS_TRUST_POLICIES = ['developer-id', 'adhoc-pre-048'];
export function macosTrustPolicy(value) {
  const policy = value?.trim() || 'developer-id';
  if (!MACOS_TRUST_POLICIES.includes(policy)) throw new Error('MACOS_TRUST_POLICY_INVALID');
  return policy;
}

/** The sealed release.json must name exactly this target and build. */
export function assertMacosPackageIdentity(metadata, arch, buildId = BUILD_ID) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    metadata.target !== `macos-${arch}` ||
    metadata.architecture !== arch ||
    metadata.buildId !== buildId ||
    metadata.channel !== 'stable'
  )
    throw new Error('MACOS_PACKAGE_IDENTITY_MISMATCH');
}
export function assertMacosSigner(details, expectedTeam) {
  if (
    !/^[A-Z0-9]{10}$/u.test(expectedTeam ?? '') ||
    !details.split(/\r?\n/u).includes(`TeamIdentifier=${expectedTeam}`) ||
    !/^Authority=Developer ID Application:/mu.test(details) ||
    !/\bflags=[^\n]*\bruntime\b/u.test(details)
  )
    throw new Error('MACOS_APPLE_TRUST_UNPROVEN');
}
export async function verifyMacosReleaseTrust(dmg, arch, expectedTeam, policy = 'developer-id') {
  policy = macosTrustPolicy(policy);
  if (policy === 'developer-id' && !/^[A-Z0-9]{10}$/u.test(expectedTeam ?? ''))
    throw new Error(
      'MACOS_EXPECTED_TEAM_ID_REQUIRED: set MACOS_EXPECTED_TEAM_ID for Developer ID releases, ' +
        'or explicitly SOTY_MACOS_TRUST_POLICY=adhoc-pre-048 to ship without Apple trust as before 048'
    );
  const root = await mkdtemp(path.join(tmpdir(), 'soty-trust-'));
  const mount = path.join(root, 'mounted');
  let attempted = false;
  let detached = false;
  const run = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });
  try {
    attempted = true;
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    const app = path.join(mount, 'Soty.app');
    await verifyMacosPayload(app, arch);
    assertMacosPackageIdentity(
      JSON.parse(await readFile(path.join(app, 'Contents/Resources/release.json'), 'utf8')),
      arch
    );
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    if (policy === 'adhoc-pre-048')
      return {
        target: `macos-${arch}`,
        trustPolicy: policy,
        appleTrust: 'unverified',
        developerId: false,
        notarized: false,
        stapled: false
      };
    // codesign writes inspection details to stderr even on success.
    const { spawnSync } = await import('node:child_process');
    const identity = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], {
      encoding: 'utf8',
      timeout: 30000
    });
    if (identity.status !== 0) throw new Error('MACOS_SIGNER_INSPECTION_FAILED');
    assertMacosSigner(identity.stderr, expectedTeam);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    return {
      target: `macos-${arch}`,
      trustPolicy: policy,
      appleTrust: 'verified',
      developerId: true,
      notarized: true,
      stapled: true
    };
  } finally {
    if (attempted) {
      try {
        run('/usr/bin/hdiutil', ['detach', '-quiet', mount]);
        detached = true;
      } catch {
        /* Never force-detach or delete mounted evidence. */
      }
    }
    if (!attempted || detached) await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dmg, ...args] = process.argv.slice(2);
  const target = parseMacosTarget(args);
  if (!dmg || !path.isAbsolute(path.resolve(dmg))) throw new Error('MACOS_TRUST_INPUT_INVALID');
  process.stdout.write(
    `${JSON.stringify(
      await verifyMacosReleaseTrust(
        path.resolve(dmg),
        target.arch,
        process.env.MACOS_EXPECTED_TEAM_ID,
        process.env.SOTY_MACOS_TRUST_POLICY
      )
    )}\n`
  );
}
