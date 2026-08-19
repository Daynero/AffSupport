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
 * Windows has no SIGSTOP, so the estimator cannot be suspended while a
 * prioritized compression runs. The queue is written to fall through in that
 * case rather than wedge, and no user-facing pause control exists — these tests
 * hold that contract, which is what lets the capability simply be absent on
 * Windows instead of failing at call time.
 */
afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('process pause across platforms', () => {
  it('is unavailable on Windows and refuses cleanly', () => {
    setPlatform('win32');
    expect(capabilities().processPause).toBe(false);
    expect(processPauseSupported()).toBe(false);

    const child = fakeChild();
    expect(pauseProcess(child)).toBe(false);
    expect(resumeProcess(child)).toBe(false);
    // Crucially it must not even attempt to deliver a signal Windows lacks.
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
