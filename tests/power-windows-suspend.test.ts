import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsSuspendHelper } from '../apps/agent/src/platform/windows-suspend.js';
import {
  capabilities,
  pauseProcess,
  processPauseSupported,
  resumeProcess,
  setWindowsSuspendHelper
} from '../apps/agent/src/platform/platform.js';

/**
 * Windows has no SIGSTOP, so without this helper the live half of the power
 * throttle would be macOS-only — thread counts and priority are fixed at spawn,
 * and the only way to reach running work is to stop and start it.
 *
 * It also repays an existing debt: the compressor's "pause the encode while
 * estimates run" path has been a silent no-op on Windows since it was written.
 */

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** A stand-in for the PowerShell process; records what was written to stdin. */
function fakeHelperProcess() {
  const written: string[] = [];
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const child = Object.assign(emitter, {
    stdin: {
      writable: true,
      write: vi.fn((chunk: string) => {
        written.push(chunk);
        return true;
      }),
      end: vi.fn(() => {
        queueMicrotask(() => emitter.emit('close', 0));
      })
    },
    kill: vi.fn(() => true)
  }) as unknown as ChildProcess;
  return { child, written, emitter };
}

afterEach(async () => {
  setPlatform(realPlatform);
  setWindowsSuspendHelper(null);
  vi.restoreAllMocks();
});

describe('helper protocol', () => {
  it('frames suspend and resume commands', () => {
    const { child, written } = fakeHelperProcess();
    const helper = new WindowsSuspendHelper({ spawnHelper: () => child });

    expect(helper.suspend(4242)).toBe(true);
    expect(helper.resume(4242)).toBe(true);
    expect(written).toEqual(['s 4242\n', 'r 4242\n']);
  });

  it('starts the helper lazily', () => {
    const spawnHelper = vi.fn(() => fakeHelperProcess().child);
    const helper = new WindowsSuspendHelper({ spawnHelper });

    // A user who never reduces the limit must never pay for a resident
    // PowerShell process.
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(helper.running()).toBe(false);

    helper.suspend(1);
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(helper.running()).toBe(true);
  });

  it('reuses one warm helper for every command', () => {
    const spawnHelper = vi.fn(() => fakeHelperProcess().child);
    const helper = new WindowsSuspendHelper({ spawnHelper });
    for (let index = 0; index < 20; index += 1) helper.suspend(100 + index);
    // PowerShell start-up is ~200 ms; paying it per suspend at 5 Hz would be
    // absurd, which is the whole reason the helper is long-lived.
    expect(spawnHelper).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('refuses to write %s as a pid', pid => {
    const { child, written } = fakeHelperProcess();
    const helper = new WindowsSuspendHelper({ spawnHelper: () => child });
    expect(helper.suspend(pid)).toBe(false);
    // Nothing but a validated integer ever crosses into the shell helper.
    expect(written).toEqual([]);
  });

  it('respawns after the helper dies instead of wedging', () => {
    const processes = [fakeHelperProcess(), fakeHelperProcess()];
    let index = 0;
    const helper = new WindowsSuspendHelper({ spawnHelper: () => processes[index++].child });

    helper.suspend(1);
    processes[0].emitter.emit('close', 1);

    helper.suspend(2);
    // Losing the helper must not leave the governor unable to throttle for the
    // rest of the session.
    expect(index).toBe(2);
    expect(processes[1].written).toEqual(['s 2\n']);
  });

  it('reports failure rather than throwing when the helper cannot start', () => {
    const onError = vi.fn();
    const helper = new WindowsSuspendHelper({
      spawnHelper: () => {
        throw new Error('ENOENT');
      },
      onError
    });
    expect(helper.suspend(1)).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('ends the helper cleanly on shutdown', async () => {
    const { child } = fakeHelperProcess();
    const helper = new WindowsSuspendHelper({ spawnHelper: () => child });
    helper.suspend(1);
    await helper.shutdown();
    expect(child.stdin?.end).toHaveBeenCalled();
    expect(helper.running()).toBe(false);
  });

  it('refuses commands after shutdown', async () => {
    const spawnHelper = vi.fn(() => fakeHelperProcess().child);
    const helper = new WindowsSuspendHelper({ spawnHelper });
    helper.suspend(1);
    await helper.shutdown();
    expect(helper.suspend(2)).toBe(false);
    expect(spawnHelper).toHaveBeenCalledTimes(1);
  });
});

describe('platform capability', () => {
  it('now reports process pause on Windows', () => {
    setPlatform('win32');
    // Previously false, which made every suspend on Windows a silent no-op.
    expect(capabilities().processPause).toBe(true);
    expect(processPauseSupported()).toBe(true);
  });

  it('routes Windows suspend and resume through the helper, never a signal', () => {
    setPlatform('win32');
    const { child, written } = fakeHelperProcess();
    setWindowsSuspendHelper(new WindowsSuspendHelper({ spawnHelper: () => child }));

    const kill = vi.fn(() => true);
    const target = { pid: 4242, kill } as unknown as ChildProcess;

    expect(pauseProcess(target)).toBe(true);
    expect(resumeProcess(target)).toBe(true);
    expect(written).toEqual(['s 4242\n', 'r 4242\n']);
    // Windows has no SIGSTOP; attempting to deliver one would do nothing at all.
    expect(kill).not.toHaveBeenCalled();
  });

  it('still uses POSIX signals on macOS', () => {
    setPlatform('darwin');
    const signals: string[] = [];
    const target = {
      pid: 4242,
      kill: vi.fn((signal: string) => {
        signals.push(signal);
        return true;
      })
    } as unknown as ChildProcess;

    expect(pauseProcess(target)).toBe(true);
    expect(resumeProcess(target)).toBe(true);
    expect(signals).toEqual(['SIGSTOP', 'SIGCONT']);
  });

  it('refuses cleanly when a Windows child has no pid', () => {
    setPlatform('win32');
    const { child } = fakeHelperProcess();
    setWindowsSuspendHelper(new WindowsSuspendHelper({ spawnHelper: () => child }));
    const target = { kill: vi.fn(() => true) } as unknown as ChildProcess;
    expect(pauseProcess(target)).toBe(false);
  });
});
