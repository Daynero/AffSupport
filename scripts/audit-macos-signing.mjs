import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertMacosHardenedMachOs } from './verify-macos-release-trust.mjs';
import { readSigningSummary } from './lib/macos-signing-summary.mjs';
import { sha256File } from './lib/sha256-file.mjs';

/**
 * 048 FR-008 / T008. What a packaged beta — or any bundle signed through the chain —
 * must show before its pass says anything about the production chain: every Mach-O
 * carries the hardened runtime and none of the forbidden entitlements, and the chain's
 * own summary beside the package describes this bundle: every file it attests is still
 * byte-for-byte what it produced. With `expectedTeam` every Mach-O must also carry
 * that team's Developer ID signature and a timestamp. Returns the record the beta
 * proof embeds as `codeSigning`. Never executes payload.
 * @param {string} app
 * @param {string} signingFile
 * @param {{ expectedTeam?: string | null }} [options]
 */
export async function auditMacosSigning(app, signingFile, { expectedTeam = null } = {}) {
  const signing = await readSigningSummary(signingFile);
  if (!signing.ok)
    throw new Error(`MACOS_SIGNING_SUMMARY_UNUSABLE: ${signing.error} (${signingFile})`);
  if (path.basename(signing.value.app) !== path.basename(app))
    throw new Error(`MACOS_SIGNING_SUMMARY_APP_MISMATCH: ${signing.value.app}`);
  const hardenedMachO = await assertMacosHardenedMachOs(app, expectedTeam ? { expectedTeam } : {});
  // The gate also counts the binaries inside nested bundles, so it sees at least as many.
  if (hardenedMachO < signing.value.machO)
    throw new Error(
      `MACOS_SIGNING_SUMMARY_COUNT_MISMATCH: ${hardenedMachO} hardened, ${signing.value.machO} summarised`
    );
  for (const entry of signing.value.files) {
    const digest = await sha256File(path.join(app, entry.path)).catch(() => null);
    if (digest !== entry.after)
      throw new Error(`MACOS_SIGNING_SUMMARY_FILE_MISMATCH: ${entry.path}`);
  }
  const { identity, teamId, machO, nestedBundles, profiles, notarized, stapled } = signing.value;
  return {
    chain: 'sign-mac-app',
    identity,
    teamId,
    hardenedMachO,
    machO,
    nestedBundles,
    profiles,
    notarized,
    stapled
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [app, ...rest] = process.argv.slice(2);
  const signingFile = rest.find(arg => arg.startsWith('--signing='))?.slice('--signing='.length);
  const expectedTeam = rest.find(arg => arg.startsWith('--team='))?.slice('--team='.length) ?? null;
  if (!app || !signingFile) {
    process.stderr.write(
      'usage: node scripts/audit-macos-signing.mjs <App.app> --signing=<signing.json> [--team=<TEAMID>]\n'
    );
    process.exit(1);
  }
  try {
    const audit = await auditMacosSigning(path.resolve(app), path.resolve(signingFile), {
      expectedTeam
    });
    process.stdout.write(`${JSON.stringify(audit)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
