import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  capabilities,
  pauseProcess,
  processPauseSupported,
  resumeProcess
} from '../apps/agent/src/platform/platform.js';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

function fakeChild(killResult: boolean | Error = true) {
  return {
    kill: vi.fn((signal: string) => {
      void signal;
      if (killResult instanceof Error) throw killResult;
      return killResult;
    })
  } as unknown as ChildProcess;
}

/**
 * Suspension used to be macOS-only: Windows has no SIGSTOP, so the encode could
 * not be paused while prioritized estimates ran, and the queue fell through
 * rather than wedging.
 *
 * The power throttle needed the same primitive to hold running work to a limit,
 * so Windows now goes through a resident PowerShell helper calling
 * NtSuspendProcess. These tests hold the remaining platform contract: whatever
 * the mechanism, a raw SIGSTOP is never delivered on Windows.
 */
afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('process pause across platforms', () => {
  it('is available on Windows and never delivers a POSIX signal', () => {
    setPlatform('win32');
    expect(capabilities().processPause).toBe(true);
    expect(processPauseSupported()).toBe(true);

    const child = fakeChild();
    pauseProcess(child);
    resumeProcess(child);
    // Crucially it must not attempt to deliver a signal Windows lacks; the
    // helper does the work instead.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('suspends and resumes on macOS', () => {
    setPlatform('darwin');
    expect(capabilities().processPause).toBe(true);

    const child = fakeChild();
    expect(pauseProcess(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGSTOP');
    expect(resumeProcess(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGCONT');
  });

  it('reports failure rather than throwing when the signal cannot be delivered', () => {
    setPlatform('darwin');
    const gone = fakeChild(new Error('ESRCH'));
    expect(pauseProcess(gone)).toBe(false);
    expect(resumeProcess(gone)).toBe(false);
  });

  it('treats a refused signal as "not paused", so callers keep going', () => {
    setPlatform('darwin');
    const stubborn = fakeChild(false);
    expect(pauseProcess(stubborn)).toBe(false);
  });
});
