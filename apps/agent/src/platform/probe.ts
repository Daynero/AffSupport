import { spawn } from 'node:child_process';

export interface ExecutableProbe {
  runnable: boolean;
  /** Why it said no, in the operating system's own words: ENOENT, UNKNOWN, TIMEOUT, EXIT_1. */
  failure: string | null;
}

const runnableProbe: ExecutableProbe = { runnable: true, failure: null };

function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

/**
 * Asks whether a binary can actually be launched, and never throws while asking.
 *
 * Node defers only ENOENT, EACCES, EAGAIN, EMFILE and ENFILE to the `error` event; every
 * other spawn failure is thrown from the call itself. A bundled executable that is present
 * but refused — Smart App Control on Windows 11, an antivirus quarantine, a policy against
 * unsigned binaries — fails with UNKNOWN, and that throw used to escape the probe and take
 * the whole agent down at boot, before it could tell anyone which tool was missing.
 */
export function probeExecutable(
  command: string,
  args: string[],
  timeoutMs = 10_000
): Promise<ExecutableProbe> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      resolve({ runnable: false, failure: failureCode(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ runnable: false, failure: 'TIMEOUT' });
    }, timeoutMs);
    timer.unref();
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ runnable: false, failure: failureCode(error) });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) {
        resolve(runnableProbe);
        return;
      }
      resolve({ runnable: false, failure: signal ? `SIGNAL_${signal}` : `EXIT_${code ?? 'UNKNOWN'}` });
    });
  });
}
