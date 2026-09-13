#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PROTOCOL_VERSION } from './lib/release/bridge-inbox.mjs';

/**
 * Installs the two things a release depends on and cannot build for itself.
 *
 * The probe's own source says it: "Built once by the runner installer, never by
 * a release." There was no installer. So the probe was never built, the bridge
 * was never registered, and preflight refused every time — correctly, and
 * permanently, because nothing was ever going to change its mind.
 *
 * Both are deliberately outside the repository's tracked state. The probe is a
 * native binary for one architecture and the bridge config names an absolute
 * path on one machine; committing either would be committing somebody else's
 * installation. They live in `release/automation/`, which is ignored, and this
 * command rebuilds them from tracked source whenever it is run.
 *
 * Usage:
 *   node scripts/install-release-runner.mjs [--print-env]
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const automation = path.join(root, 'release/automation');
const probeSource = path.join(root, 'packaging/release/ResourceProbe.swift');
const probeBinary = path.join(automation, 'probe/soty-resource-probe');
const bridgeExecutable = path.join(root, 'scripts/release-bridge.mjs');
const bridgeConfigPath = path.join(automation, 'release-bridge.json');
const envPath = path.join(automation, 'release-runner.env');

function fail(message) {
  process.stderr.write(`Release runner install failed: ${message}\n`);
  process.exit(1);
}

if (process.platform !== 'darwin')
  fail('the resource probe is a macOS binary; a release is cut on the owner’s Mac');
if (!existsSync(probeSource)) fail(`no probe source at ${path.relative(root, probeSource)}`);

mkdirSync(path.dirname(probeBinary), { recursive: true, mode: 0o700 });
try {
  // -O because the probe is read in a loop while the machine is under load, and
  // a measurement that costs what it measures is not a measurement.
  execFileSync('swiftc', ['-O', '-o', probeBinary, probeSource], { stdio: 'pipe' });
} catch (error) {
  fail(`swiftc could not build the probe: ${error instanceof Error ? error.message : 'unknown'}`);
}

const probeDigest = createHash('sha256').update(readFileSync(probeBinary)).digest('hex');

// Proven by running it, not by its existence: a binary that builds and then
// answers with something the scheduler cannot parse is the failure this catches.
try {
  const reading = JSON.parse(execFileSync(probeBinary, ['/'], { encoding: 'utf8' }));
  for (const signal of ['cpuTicks', 'physicalBytes', 'diskFreeBytes'])
    if (reading[signal] === undefined) fail(`the probe reports no ${signal}`);
} catch (error) {
  fail(
    `the probe did not produce a reading: ${error instanceof Error ? error.message : 'unknown'}`
  );
}

chmodSync(bridgeExecutable, 0o755);
writeFileSync(
  bridgeConfigPath,
  `${JSON.stringify(
    {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      executable: bridgeExecutable,
      // The allow-list is the registration. The runner may name a target; it may
      // never name an executable, so the only programs it can ever speak to are
      // the ones written down here by an install.
      allowedExecutables: [bridgeExecutable]
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

/**
 * The packaged runtime the beta build borrows.
 *
 * `package-beta-mac.sh` refuses without a verified packaged app and offers this
 * variable as the supported alternative to building one. A release builds in an
 * isolated checkout, which by definition has never packaged anything, so the
 * runtime has to be named rather than found.
 */
const runtimeApp = path.join(root, 'release/Soty.app');

const environment = [
  `SOTY_RELEASE_PROBE=${probeBinary}`,
  `SOTY_RELEASE_PROBE_DIGEST=${probeDigest}`,
  `SOTY_RELEASE_BRIDGE_CONFIG=${bridgeConfigPath}`,
  ...(existsSync(runtimeApp) ? [`BETA_RUNTIME_SOURCE_APP=${runtimeApp}`] : [])
];
writeFileSync(envPath, `${environment.join('\n')}\n`, { mode: 0o600 });

if (process.argv.includes('--print-env')) {
  process.stdout.write(`${environment.join('\n')}\n`);
} else {
  process.stdout.write(
    `Release runner installed.\n` +
      `  probe   ${path.relative(root, probeBinary)} (${probeDigest.slice(0, 12)}…)\n` +
      `  bridge  ${path.relative(root, bridgeConfigPath)}\n` +
      `  env     ${path.relative(root, envPath)} — source it before a release\n`
  );
}
