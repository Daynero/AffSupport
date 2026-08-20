/**
 * Stops the beta environment cleanly.
 *
 * Anything still holding a beta port is asked to stop, then killed if it will
 * not; the local stack is stopped last. The command exits non-zero naming
 * whatever would not release, so "it looked like it stopped" is never the
 * outcome.
 */
import { spawnSync } from 'node:child_process';
import { BETA_LOCAL_STACK_PORTS, BETA_PROFILE } from '../packages/shared/dist/environment.js';

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

for (const port of appPorts) {
  const pids = listeners(port);
  if (!pids.length) continue;
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

process.stdout.write(
  `Beta stopped. Released ports: ${stopped.length ? stopped.join(', ') : 'none were held'}.\n`
);
