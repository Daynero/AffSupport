/**
 * Stops the beta environment cleanly.
 *
 * Anything still holding a beta port is asked to stop, then killed if it will
 * not; the local stack is stopped last. The command exits non-zero naming
 * whatever would not release, so "it looked like it stopped" is never the
 * outcome.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { BETA_LOCAL_STACK_PORTS, BETA_PROFILE } from '../packages/shared/dist/environment.js';
import { betaStopPolicy } from './lib/release/beta-service.mjs';
import { restorableEnv } from './lib/release/adapters/beta.mjs';

/**
 * PIDs listening on `port`.
 *
 * An `lsof` that could not run is NOT the same answer as "nothing is
 * listening", and conflating them is how this script would report a clean stop
 * on a host where it had checked nothing at all — the exact outcome its own
 * contract rules out. `lsof` exiting 1 with no output is the ordinary "no
 * match" case; a spawn error is not.
 */
function listeners(port) {
  const result = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    shell: false,
    encoding: 'utf8'
  });
  if (result.error) {
    process.stderr.write(
      `Beta stop cannot verify port ${port}: lsof is unavailable (${result.error.message}).\n`
    );
    process.exit(1);
  }
  if (!result.stdout) return [];
  return result.stdout
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0);
}

function sleep(milliseconds) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

const appPorts = [BETA_PROFILE.agentPort, BETA_PROFILE.webPort];
const stopped = [];
const ownershipPath = path.resolve('release/automation/beta-service.json');
if (!existsSync(ownershipPath)) {
  process.stderr.write(
    'Beta stop refused: no local ownership record exists; listeners are borrowed.\n'
  );
  process.exit(1);
}
let ownership;
try {
  ownership = JSON.parse(readFileSync(ownershipPath, 'utf8'));
} catch {
  process.stderr.write('Beta stop refused: the local ownership record is unreadable.\n');
  process.exit(1);
}
if (ownership?.schemaVersion !== 1 || !ownership.stackStarted || !Array.isArray(ownership.ports)) {
  process.stderr.write('Beta stop refused: the local ownership record is invalid.\n');
  process.exit(1);
}
const initialListeners = Object.fromEntries(appPorts.map(port => [port, listeners(port)]));
const policy = betaStopPolicy(ownership, initialListeners, BETA_PROFILE);
if (!policy.ok) {
  process.stderr.write(
    `Beta stop refused: listener on ${policy.port ?? 'an unknown port'} is borrowed.\n`
  );
  process.exit(1);
}

for (const port of appPorts) {
  const pids = listeners(port);
  if (!pids.length) continue;
  if (!betaStopPolicy(ownership, { [String(port)]: pids }, BETA_PROFILE).ok) {
    process.stderr.write(`Beta stop refused: listener on ${port} changed ownership.\n`);
    process.exit(1);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between the probe and the signal; nothing to do.
    }
  }
  stopped.push(port);
}

// Give SIGTERM a chance before escalating, then force anything still holding a
// port so a stuck child cannot leave the environment half-up.
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!appPorts.some(port => listeners(port).length)) break;
  sleep(100);
}
for (const port of appPorts) {
  for (const pid of listeners(port)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Nothing to do.
    }
  }
}

const stack = spawnSync('npx', ['supabase', 'stop'], { shell: false, stdio: 'inherit' });

const stillHeld = [...appPorts, ...BETA_LOCAL_STACK_PORTS].filter(port => listeners(port).length);
if (stillHeld.length || stack.status !== 0) {
  process.stderr.write(
    `Beta stop incomplete. Still listening: ${stillHeld.join(', ') || 'none'}` +
      `${stack.status !== 0 ? '; the local Supabase stack did not stop cleanly' : ''}.\n`
  );
  process.exit(1);
}

// Roll back only files this stack wrote and nobody has touched since. An
// environment file edited while beta was up carries newer intent than our
// record of it, and restoring over that would destroy work that was not ours.
const keptEnvironment = [];
for (const written of ownership.writtenEnvironment ?? []) {
  const current = existsSync(written.file) ? readFileSync(written.file) : null;
  const verdict = restorableEnv({ writtenDigest: written.digest, currentContent: current });
  if (!verdict.ok) {
    keptEnvironment.push(`${written.file} (${verdict.code})`);
    continue;
  }
  if (written.restoreFrom && existsSync(written.restoreFrom))
    copyFileSync(written.restoreFrom, written.file);
  else unlinkSync(written.file);
}

process.stdout.write(
  `Beta stopped. Released ports: ${stopped.length ? stopped.join(', ') : 'none were held'}.\n` +
    (keptEnvironment.length
      ? `Left in place because it changed since beta wrote it: ${keptEnvironment.join(', ')}.\n`
      : '')
);
unlinkSync(ownershipPath);
