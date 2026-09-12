import { spawn } from 'node:child_process';
import { createRedactor } from './redaction.mjs';

/** @param {string[]} argv @param {{cwd: string, env?: Record<string, string>, timeoutMs?: number, onOutput?: (text: string) => void, lease?: {leaseId: string} | null, admission?: {request: () => Promise<{ok: boolean, lease?: {leaseId: string}, reason?: string}>, release?: (lease: {leaseId: string}) => Promise<void>} | null}} options */
export async function execute(argv, { cwd, env = {}, timeoutMs, onOutput = () => {}, lease = null, admission = null }) {
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
/** @param {unknown} error */
function redactTextError(error) { return error instanceof Error ? error.message.replace(/\S{48,}/gu, '[REDACTED_SECRET]') : String(error); }
