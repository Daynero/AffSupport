import { spawn } from 'node:child_process';
import { createRedactor } from './redaction.mjs';
import { terminateGateTree } from '../gate-process-tree.mjs';
import { processIdentity } from './target-ownership.mjs';

/**
 * @param {string[]} argv
 * @param {{cwd: string, env?: Record<string, string>, timeoutMs?: number,
 *   onOutput?: (text: string) => void, managedTree?: boolean,
 *   onSpawn?: (identity: {pid: number|null, processGroupId: number|null, startedAt: number, leaseId: string|null, startMarker: string|null, bootId: string|null}) => void|Promise<void>,
 *   lease?: {leaseId: string} | null,
 *   admission?: {request: () => Promise<{ok: boolean, lease?: {leaseId: string}, reason?: string}>, release?: (lease: {leaseId: string}) => Promise<void>} | null}} options
 */
export async function execute(argv, { cwd, env = {}, timeoutMs, onOutput = () => {}, lease = null, admission = null, managedTree = false, onSpawn }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string' || !value)) throw new Error('argv must be a non-empty string array');
  if (!cwd) throw new Error('cwd is required');
  let admittedLease = lease;
  if (admission) {
    const decision = await admission.request();
    if (!decision?.ok || !decision.lease) {
      return { ok: false, code: decision?.reason ?? 'RESOURCE_WAIT', timedOut: false, output: [], identity: null };
    }
    admittedLease = decision.lease;
  }
  const redactor = createRedactor();
  const output = [];
  /** @param {string} value */
  const push = value => { if (!value) return; output.push(value); if (output.length > 200) output.shift(); onOutput(value); };
  if (managedTree) return executeManagedTree(argv, {
    cwd, env, timeoutMs, admission, admittedLease, redactor, output, push, onSpawn
  });
  return new Promise(resolve => {
    const child = spawn('nice', ['-n', '15', ...argv], { cwd, env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = { pid: child.pid ?? null, startedAt: Date.now(), leaseId: admittedLease?.leaseId ?? null };
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    timer?.unref?.();
    child.stdout.on('data', chunk => push(redactor.write(chunk)));
    child.stderr.on('data', chunk => push(redactor.write(chunk)));
    child.once('error', async error => { if (timer) clearTimeout(timer); push(redactor.end()); if (admission && admittedLease) await admission.release?.(admittedLease); resolve({ ok: false, code: null, timedOut, output, identity, error: redactTextError(error) }); });
    child.once('close', async code => { if (timer) clearTimeout(timer); push(redactor.end()); if (admission && admittedLease) await admission.release?.(admittedLease); resolve({ ok: code === 0 && !timedOut, code, timedOut, output, identity }); });
  });
}

const TREE_TERM_GRACE_MS = 2000;
const TREE_DRAIN_MS = 1000;

/** False is proof of absence; EPERM and every other uncertainty remain unknown. */
function privateGroupPresent(pid) {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 1 || pid === process.pid) return null;
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return null;
  }
}

/** Opt-in POSIX supervision. The legacy runner's process semantics above stay unchanged. */
function executeManagedTree(argv, { cwd, env, timeoutMs, admission, admittedLease, redactor, output, push, onSpawn }) {
  if (process.platform === 'win32') return Promise.resolve({
    ok: false, code: 'MANAGED_TREE_UNSUPPORTED', timedOut: false, output, identity: null,
    cleanupConfirmed: true, interrupted: null
  }).then(async result => {
    if (admission && admittedLease) await admission.release?.(admittedLease);
    return result;
  });
  return new Promise(resolve => {
    const child = spawn('nice', ['-n', '15', ...argv], {
      cwd, env: { ...process.env, ...env }, shell: false, detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const identity = {
      pid: child.pid ?? null, processGroupId: child.pid ?? null, startedAt: Date.now(),
      leaseId: admittedLease?.leaseId ?? null,
      startMarker: /** @type {string|null} */ (null), bootId: /** @type {string|null} */ (null)
    };
    let timedOut = false;
    let closed = false;
    let exited = false;
    let settled = false;
    let stopping = false;
    let initialized = false;
    /** @type {number|null} */ let exitCode = null;
    /** @type {string|null} */ let interrupted = null;
    /** @type {string|null} */ let failure = null;
    /** @type {NodeJS.Timeout|null} */ let grace = null;
    /** @type {NodeJS.Timeout|null} */ let drain = null;
    /** @type {NodeJS.Timeout|null} */ let poll = null;
    /** @type {NodeJS.Timeout|null} */ let deadline = null;
    const term = () => stop('SIGTERM');
    const interrupt = () => stop('SIGINT');

    async function finish(cleanupConfirmed) {
      if (settled) return;
      settled = true;
      for (const timer of [grace, drain, poll, deadline]) if (timer) clearTimeout(timer);
      process.removeListener('SIGTERM', term);
      process.removeListener('SIGINT', interrupt);
      child.stdout.destroy();
      child.stderr.destroy();
      // A pipe held by an escaped/unknown process must not hold the caller open.
      // cleanupConfirmed=false prevents the result becoming a successful gate.
      child.unref();
      push(redactor.end());
      if (admission && admittedLease) {
        try { await admission.release?.(admittedLease); }
        catch { failure ??= 'EXECUTION_LEASE_RELEASE_UNCONFIRMED'; }
      }
      resolve({
        ok: exitCode === 0 && !timedOut && !interrupted && !failure && cleanupConfirmed,
        code: exitCode, timedOut, output, identity, cleanupConfirmed, interrupted,
        ...(failure ? { error: failure } : {})
      });
    }

    function maybeFinish() {
      if (settled || !closed || !initialized) return;
      if (!child.pid || privateGroupPresent(child.pid) === false) void finish(true);
      else if (!stopping) stop('lingering_descendants');
    }

    function killAndDrain() {
      if (settled) return;
      const present = child.pid ? privateGroupPresent(child.pid) : false;
      if (present !== false && child.pid) terminateGateTree(child);
      // Completion is observed, not inferred from a successful kill request.
      const observe = () => {
        if (settled) return;
        if (closed && (!child.pid || privateGroupPresent(child.pid) === false)) {
          void finish(true);
          return;
        }
        poll = setTimeout(observe, 25);
      };
      observe();
      drain = setTimeout(() => {
        const confirmed = closed && (!child.pid || privateGroupPresent(child.pid) === false);
        if (!confirmed) failure ??= 'EXECUTION_CLEANUP_UNCONFIRMED';
        void finish(confirmed);
      }, TREE_DRAIN_MS);
    }

    function stop(reason) {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'SIGTERM' || reason === 'SIGINT') interrupted ??= reason;
      if (reason === 'lingering_descendants') failure ??= 'EXECUTION_DESCENDANTS_REMAINED';
      if (stopping) return;
      stopping = true;
      if (deadline) clearTimeout(deadline);
      const present = child.pid ? privateGroupPresent(child.pid) : false;
      if (present !== false && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            failure ??= 'EXECUTION_CLEANUP_UNCONFIRMED';
        }
      }
      if (closed && initialized && present === false) { void finish(true); return; }
      // These referenced timers deliberately keep supervision alive after the
      // leader exits while its descendants still own the process group/pipes.
      grace = setTimeout(killAndDrain, TREE_TERM_GRACE_MS);
    }

    child.stdout.on('data', chunk => push(redactor.write(chunk)));
    child.stderr.on('data', chunk => push(redactor.write(chunk)));
    child.once('error', error => {
      failure = redactTextError(error);
      initialized = true;
      stop('spawn_error');
      maybeFinish();
    });
    child.once('exit', code => {
      exited = true;
      exitCode = code;
      if (code !== 0 || privateGroupPresent(child.pid) !== false)
        stop(code === 0 ? 'lingering_descendants' : 'leader_exit');
    });
    child.once('close', code => {
      closed = true;
      if (!exited) exitCode = code;
      maybeFinish();
    });
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    deadline = setTimeout(() => stop('timeout'), timeoutMs ?? 15 * 60_000);
    // The hook is trusted parent code, never a candidate-selected command.
    void (async () => {
      try {
        const observed = child.pid ? await processIdentity(child.pid).catch(() => null) : null;
        if (settled) return;
        identity.startMarker = observed?.startMarker ?? null;
        identity.bootId = observed?.bootId ?? null;
        await onSpawn?.(identity);
      } catch {
        failure = 'EXECUTION_SPAWN_OBSERVATION_FAILED';
        stop('spawn_hook_failed');
      } finally {
        initialized = true;
        maybeFinish();
      }
    })();
  });
}
/** @param {unknown} error */
function redactTextError(error) { return error instanceof Error ? error.message.replace(/\S{48,}/gu, '[REDACTED_SECRET]') : String(error); }
