/**
 * A packaged Agent belongs to its small native launcher. `process.ppid` alone
 * is not enough to prove that relationship: if the launcher exits during the
 * short window before Node starts, macOS can hand Node to launchd immediately
 * and the old Agent will remember PID 1 as its parent forever. The launcher
 * therefore also passes its own PID explicitly.
 */
export function parseLauncherPid(value: string | undefined): number | null {
  const pid = value ? Number(value) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means the process exists; the launcher and Agent normally run
    // as the same macOS user, but treating it as alive avoids a false shutdown.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function packagedAgentLostLauncher(input: {
  initialParentPid: number;
  currentParentPid: number;
  launcherPid: number | null;
  isAlive: (pid: number) => boolean;
}): boolean {
  return (
    input.currentParentPid !== input.initialParentPid ||
    (input.launcherPid !== null && !input.isAlive(input.launcherPid))
  );
}
