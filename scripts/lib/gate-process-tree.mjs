import { execFileSync } from 'node:child_process';

/**
 * Only for a child spawned by gate.mjs, in its own POSIX process group.
 * detached establishes the group; it does not unref or daemonize the gate.
 * https://nodejs.org/api/child_process.html#optionsdetached
 * https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
 * @param {Pick<import('node:child_process').ChildProcess, 'pid' | 'exitCode' | 'kill'>} child
 * @param {NodeJS.Platform} platform
 * @returns {'requested' | 'already_exited' | 'unconfirmed'}
 */
export function terminateGateTree(child, platform = process.platform) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 1 || pid === process.pid) return 'unconfirmed';
  try {
    if (platform === 'win32') {
      // A reaped wrapper PID is no longer an owned target. Never guess by name.
      if (child.exitCode !== null) return 'unconfirmed';
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000
      });
    } else {
      // npm and its non-detached descendants inherit the gate's private group.
      process.kill(-pid, 'SIGKILL');
    }
    return 'requested';
  } catch (error) {
    if (platform !== 'win32' && error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return 'already_exited';
    // Best effort for the direct child is not proof of descendant termination.
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* Report uncertainty below. */
      }
    }
    return 'unconfirmed';
  }
}
