import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMacosTarget } from './lib/macos-target.mjs';
import { isMachOFile, verifyMacosPayload } from './lib/macos-payload.mjs';
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

/**
 * Entitlements no distributed binary may carry (048 FR-002): each switches off a
 * hardened-runtime protection, and `get-task-allow` is refused by notarization.
 */
export const MACOS_FORBIDDEN_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.get-task-allow'
]);

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

/**
 * One Mach-O's `codesign -dvv` details under `developer-id` (048 FR-005, SC-002): the
 * owner's team and a Developer ID authority on every binary, not only on the bundle, and
 * a secure timestamp on each. A nested binary left with another team's signature, or
 * signed without `--timestamp`, is what notarization would reject later and offline
 * Gatekeeper would distrust; the gate refuses it first.
 */
export function assertMacosMachOSigner(details, expectedTeam, relative) {
  if (
    !/^[A-Z0-9]{10}$/u.test(expectedTeam ?? '') ||
    !details.split(/\r?\n/u).includes(`TeamIdentifier=${expectedTeam}`) ||
    !/^Authority=Developer ID Application:/mu.test(details) ||
    !/^Timestamp=/mu.test(details)
  )
    throw new Error(`MACOS_MACHO_SIGNER_MISMATCH: ${relative}`);
}

/**
 * Every Mach-O in the bundle — the launcher, the loose runtime and engines in Resources,
 * the Finder extension — carries the hardened runtime and none of the forbidden
 * entitlements; with `expectedTeam` (the `developer-id` gate) also that team's Developer
 * ID signature and a secure timestamp. Signing `--deep` leaves the loose ones out, so
 * each is inspected. Returns the number inspected. Never executes payload.
 * @param {string} app
 * @param {{ expectedTeam?: string | null }} [options]
 */
export async function assertMacosHardenedMachOs(app, { expectedTeam = null } = {}) {
  const files = [];
  for (const entry of await readdir(app, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (await isMachOFile(file)) files.push(file);
  }
  if (!files.length) throw new Error('MACOS_PAYLOAD_NATIVE_MISSING');
  for (const file of files) {
    const relative = path.relative(app, file);
    const details = spawnSync('/usr/bin/codesign', ['-dvv', file], {
      encoding: 'utf8',
      timeout: 30000
    });
    if (details.status !== 0 || !/\bflags=[^\n]*\bruntime\b/u.test(details.stderr))
      throw new Error(`MACOS_HARDENED_RUNTIME_MISSING: ${relative}`);
    if (expectedTeam !== null) assertMacosMachOSigner(details.stderr, expectedTeam, relative);
    const entitlements = spawnSync(
      '/usr/bin/codesign',
      ['-d', '--entitlements', '-', '--xml', file],
      { encoding: 'utf8', timeout: 30000 }
    );
    for (const key of MACOS_FORBIDDEN_ENTITLEMENTS) {
      if (`${entitlements.stdout}${entitlements.stderr}`.includes(`<key>${key}</key>`))
        throw new Error(`MACOS_ENTITLEMENT_FORBIDDEN: ${relative} ${key}`);
    }
  }
  return files.length;
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
    const identity = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], {
      encoding: 'utf8',
      timeout: 30000
    });
    if (identity.status !== 0) throw new Error('MACOS_SIGNER_INSPECTION_FAILED');
    assertMacosSigner(identity.stderr, expectedTeam);
    const hardenedMachO = await assertMacosHardenedMachOs(app, { expectedTeam });
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    // The ticket must travel with the app, not only the image: after the drag to
    // Applications the first offline launch has nothing else to consult.
    run('/usr/bin/xcrun', ['stapler', 'validate', app]);
    run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    return {
      target: `macos-${arch}`,
      trustPolicy: policy,
      appleTrust: 'verified',
      developerId: true,
      hardenedMachO,
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
