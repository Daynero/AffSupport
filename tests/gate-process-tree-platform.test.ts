import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { terminateGateTree } from '../scripts/lib/gate-process-tree.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
});
const child = () => ({ pid: 77777, exitCode: null as number | null, kill: vi.fn(() => true) });

it('targets only the private POSIX group, never a process name or the verifier group', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(terminateGateTree(child(), 'darwin')).toBe('requested');
  expect(kill).toHaveBeenCalledExactlyOnceWith(-77777, 'SIGKILL');
});

it.each([undefined, 0, 1, NaN, process.pid])('refuses unsafe or missing child PID %s', pid => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(terminateGateTree({ ...child(), pid }, 'linux')).toBe('unconfirmed');
  expect(kill).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
});

it('recognizes an already absent group but does not hide a refused signal', () => {
  const c = child(),
    kill = vi.spyOn(process, 'kill');
  kill.mockImplementationOnce(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  expect(terminateGateTree(c, 'linux')).toBe('already_exited');
  expect(c.kill).not.toHaveBeenCalled();
  kill.mockImplementationOnce(() => {
    throw Object.assign(new Error('refused'), { code: 'EPERM' });
  });
  expect(terminateGateTree(c, 'linux')).toBe('unconfirmed');
  expect(c.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
});

it('bounds Windows taskkill and scopes it to the child PID and descendants', () => {
  expect(terminateGateTree(child(), 'win32')).toBe('requested');
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
    'taskkill.exe',
    ['/PID', '77777', '/T', '/F'],
    {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000
    }
  );
});

it('keeps Windows cleanup uncertain on timeout and never targets a reaped wrapper PID', () => {
  const c = child();
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error('timeout');
  });
  expect(terminateGateTree(c, 'win32')).toBe('unconfirmed');
  expect(c.kill).toHaveBeenCalledOnce();
  vi.mocked(execFileSync).mockClear();
  c.exitCode = 0;
  expect(terminateGateTree(c, 'win32')).toBe('unconfirmed');
  expect(execFileSync).not.toHaveBeenCalled();
});
