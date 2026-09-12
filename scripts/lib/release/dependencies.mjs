import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { inspectInstalledProbe } from './probes-macos.mjs';
import { validateBridgeConfig } from './agent-bridge.mjs';

/**
 * The two installed things a release depends on, and how to ask them whether
 * they are really there.
 *
 * Both checks are deliberately cheap and read-only: preflight must be able to
 * answer "could this release start?" without compiling anything, starting a
 * service, or invoking a model. Both also fail closed. An unconfigured probe or
 * bridge is reported as unavailable, never as absent-therefore-fine, because
 * the whole value of the check is that heavy work does not begin on a machine
 * that cannot be measured or a failure that cannot be handed off.
 */

const BRIDGE_HEALTH_TIMEOUT_MS = 2000;
const BRIDGE_HEALTH_REPLY = '{"ok":true,"protocolVersion":1}';

/**
 * Asks the registered bridge executable whether it is alive. This is a process
 * call with a fixed argument, not a prompt: no model runs to answer it.
 */
export function bridgeHealth(executable, { timeoutMs = BRIDGE_HEALTH_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, ['--release-bridge-health'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code === 0 && output.trim() === BRIDGE_HEALTH_REPLY);
    });
  });
}

/**
 * Builds the probe and bridge inspectors from the installation's configuration.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{probe: {inspect: () => Promise<{ok: boolean, code?: string, reason?: string}>},
 *            bridge: {inspect: () => Promise<{ok: boolean, code?: string}>}}}
 */
export function installedDependencies(env = process.env) {
  return {
    probe: {
      async inspect() {
        if (!env.SOTY_RELEASE_PROBE || !env.SOTY_RELEASE_PROBE_DIGEST)
          return { ok: false, code: 'PROBE_UNAVAILABLE', reason: 'not_configured' };
        return inspectInstalledProbe({
          executable: env.SOTY_RELEASE_PROBE,
          digest: env.SOTY_RELEASE_PROBE_DIGEST
        });
      }
    },
    bridge: {
      async inspect() {
        if (!env.SOTY_RELEASE_BRIDGE_CONFIG)
          return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE', reason: 'not_configured' };
        try {
          const valid = validateBridgeConfig(
            JSON.parse(await readFile(env.SOTY_RELEASE_BRIDGE_CONFIG, 'utf8'))
          );
          if (!valid.ok || !valid.value) return valid;
          await access(valid.value.executable);
          if (!(await bridgeHealth(valid.value.executable)))
            return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE', reason: 'unhealthy' };
          return { ok: true, value: valid.value };
        } catch {
          return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE', reason: 'unreadable' };
        }
      }
    }
  };
}
