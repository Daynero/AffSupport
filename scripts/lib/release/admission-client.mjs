import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requestLease } from '../../release-admit.mjs';

/**
 * The caller's half of the admission protocol.
 *
 * Two rules shape this module. Outside a release runner there is no socket and
 * nothing changes: `npm run verify` on a developer's machine behaves exactly as
 * it always did. Inside one, a *partial* configuration is an error rather than a
 * quiet bypass — a heavy gate that cannot prove it was admitted must not run,
 * because the whole point is that only one heavy thing happens at a time on a
 * machine with 8 GiB.
 *
 * The capability never travels in argv, an environment value, or any log: it is
 * read once from a descriptor the parent inherited to this process.
 */

const HEARTBEAT_MS = 5_000;
const RETRY_FLOOR_MS = 1_000;

function requireEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error(`RELEASE_ADMISSION_INCOMPLETE: ${key} is not set`);
  return value;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.());

/**
 * @returns an admission client, or null when this process is not running under
 * a release runner.
 */
export function admissionFromEnvironment(env = process.env) {
  const socketPath = env.SOTY_RELEASE_ADMIT_SOCKET;
  if (!socketPath) return null;
  const capabilityFd = requireEnv(env, 'SOTY_RELEASE_CAPABILITY_FD');
  const identity = {
    runId: requireEnv(env, 'SOTY_RELEASE_RUN_ID'),
    generation: Number(requireEnv(env, 'SOTY_RELEASE_GENERATION')),
    childIdentity: requireEnv(env, 'SOTY_RELEASE_CHILD_IDENTITY'),
    pid: Number(env.SOTY_RELEASE_CHILD_PID ?? process.pid),
    startedAt: Number(requireEnv(env, 'SOTY_RELEASE_CHILD_STARTED_AT')),
    parentLeaseId: env.SOTY_RELEASE_PARENT_LEASE ?? null
  };
  if (!Number.isInteger(identity.generation) || !Number.isInteger(identity.startedAt))
    throw new Error('RELEASE_ADMISSION_INCOMPLETE: generation and child start identity must be integers');
  // A pipe can only be drained once, so the capability is read eagerly and kept
  // in memory for the life of the process.
  const capability = readFileSync(`/dev/fd/${capabilityFd}`, 'utf8').trim();
  if (!capability) throw new Error('RELEASE_ADMISSION_INCOMPLETE: inherited capability is empty');

  const send = (operation, extra) =>
    requestLease(
      socketPath,
      { version: 1, requestId: randomUUID(), operation, ...identity, ...extra },
      capability
    );

  return {
    identity,
    /**
     * Waits for a grant, holds it with heartbeats while `run` executes, and
     * releases it exactly once. A pre-start wait is deliberately unbounded: the
     * run's own deadline, not this loop, decides when waiting is too long.
     */
    async withAdmission(stepId, run) {
      let granted = null;
      while (!granted) {
        const reply = await send('request', { stepId });
        if (reply?.kind === 'granted') granted = reply;
        else if (reply?.kind === 'waiting')
          await sleep(Math.max(RETRY_FLOOR_MS, (reply.nextCheckAt ?? 0) - Date.now()));
        else throw new Error(`RELEASE_ADMISSION_DENIED: ${reply?.code ?? 'LEASE_UNKNOWN'}`);
      }
      const heartbeat = setInterval(() => {
        send('heartbeat', { stepId, leaseId: granted.leaseId }).catch(() => {
          // A missed heartbeat is the worker's signal to treat ownership as
          // uncertain; this side keeps running its bounded step and releases.
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        return await run(granted);
      } finally {
        clearInterval(heartbeat);
        await send('release', { stepId, leaseId: granted.leaseId }).catch(() => {});
      }
    }
  };
}
