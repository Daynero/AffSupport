import { spawn } from 'node:child_process';
import { dueHandoffs, markSubmitting, recordAttempt, recordResult } from './handoff.mjs';

/**
 * Talking to the installed repair bridge, and to nothing else.
 *
 * The runner is model-independent by construction: it knows a protocol version,
 * a registered executable and four message kinds. It does not know what the
 * bridge does with a job, cannot supply the command it runs, and never invokes
 * a model to check on one. A release intent can name a target; it can never
 * name an executable.
 *
 * The reconnect rule is the part worth reading twice. After any interruption
 * the runner *queries* a job before resubmitting it, because the failure mode
 * that matters is not a lost message — it is a second repair started for a
 * failure somebody is already fixing.
 */

const PROTOCOL_VERSION = 1;
const CALL_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;

export function validateBridgeConfig(config) {
  if (!config || config.protocolVersion !== PROTOCOL_VERSION || typeof config.executable !== 'string') {
    return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE' };
  }
  if (!config.allowedExecutables?.includes(config.executable)) {
    return { ok: false, code: 'AGENT_BRIDGE_UNREGISTERED' };
  }
  return { ok: true, value: Object.freeze({ executable: config.executable, protocolVersion: PROTOCOL_VERSION }) };
}

/**
 * A transport that runs the registered executable with a fixed argument and
 * exchanges one JSON message over its stdio.
 *
 * One process per message rather than a long-lived pipe: a repair job outlives
 * any connection anyway, the durable record is the real state, and a transport
 * that cannot be half-open is one less thing that can wedge a release.
 */
export function createProcessTransport(bridge, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const child = spawn(bridge.executable, ['--release-bridge'], {
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        let reply = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('AGENT_BRIDGE_TIMEOUT'));
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on('data', chunk => {
          reply += chunk;
          if (reply.length > MAX_REPLY_BYTES) {
            child.kill('SIGKILL');
            reject(new Error('AGENT_BRIDGE_REPLY_UNBOUNDED'));
          }
        });
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(reply));
          } catch {
            reject(new Error('AGENT_BRIDGE_REPLY_INVALID'));
          }
        });
        child.stdin.end(`${JSON.stringify(request)}\n`);
      });
    }
  };
}

function message(operation, job, extra = {}) {
  return {
    version: PROTOCOL_VERSION,
    operation,
    jobId: job.jobId,
    fingerprint: job.fingerprint,
    runId: job.runId,
    ...extra
  };
}

/** A reply must be about the job we asked about, or it is not an answer at all. */
function matches(response, job) {
  return Boolean(response) && response.jobId === job.jobId && response.fingerprint === job.fingerprint;
}

/**
 * Delivers every job whose backoff has elapsed.
 *
 * Transport failure is not release failure: the record stays `delivery_pending`
 * with a longer backoff and the release stays blocked on its own terms. No
 * owner action is needed to recover a bridge that was merely restarted.
 */
export async function deliverPendingHandoffs({ directory, config, transport, now = Date.now() }) {
  const valid = validateBridgeConfig(config);
  if (!valid.ok) return valid;
  const delivered = [];
  const pending = [];
  for (const job of await dueHandoffs(directory, now)) {
    // Already submitted once: find out what the bridge knows before sending
    // anything that could start a second repair.
    const resubmission = job.submitted;
    const current = await markSubmitting(directory, job);
    try {
      const response = resubmission
        ? await transport.call(message('query', job))
        : await transport.call(message('submit', job, { payload: job.payload ?? null }));
      if (!matches(response, job)) {
        await recordAttempt(directory, current, { lastError: 'BRIDGE_RESPONSE_INVALID' }, now);
        pending.push(job.jobId);
        continue;
      }
      if (response.state === 'unknown' && resubmission) {
        // The bridge genuinely lost it; resubmitting the same jobId is safe.
        const resubmitted = await transport.call(message('submit', job, { payload: job.payload ?? null }));
        if (!matches(resubmitted, job)) {
          await recordAttempt(directory, current, { lastError: 'BRIDGE_RESPONSE_INVALID' }, now);
          pending.push(job.jobId);
          continue;
        }
        response.state = resubmitted.state;
        response.result = resubmitted.result;
      }
      const acknowledged = await recordAttempt(
        directory,
        current,
        {
          submitted: true,
          state: response.state === 'completed' ? 'completed' : 'acknowledged',
          acknowledgedAt: new Date(now).toISOString(),
          resultRef: response.resultRef ?? null,
          lastError: null
        },
        now
      );
      if (response.result?.status)
        await recordResult(directory, job.fingerprint, response.result, now);
      delivered.push(acknowledged.jobId);
    } catch {
      await recordAttempt(directory, current, { lastError: 'BRIDGE_UNAVAILABLE' }, now);
      pending.push(job.jobId);
    }
  }
  return { ok: true, delivered, pending };
}

/** Acknowledges to the bridge that the runner has taken delivery of a result. */
export async function acknowledgeHandoff({ config, transport, job }) {
  const valid = validateBridgeConfig(config);
  if (!valid.ok) return valid;
  const response = await transport.call(message('acknowledge', job));
  return matches(response, job)
    ? { ok: true }
    : { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE' };
}
