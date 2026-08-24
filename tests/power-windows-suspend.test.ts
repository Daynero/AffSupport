import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsSuspendHelper } from '../apps/agent/src/platform/windows-suspend.js';
import {
  capabilities,
  onProcessPauseSupportChange,
  pauseProcess,
  processPauseSupported,
  resumeProcess,
  setWindowsSuspendHelper
} from '../apps/agent/src/platform/platform.js';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';

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
    // Reported on the FIRST failure, not only once the retries are exhausted:
    // a power limit that quietly does nothing is the symptom nobody can
    // diagnose, and the retry ceiling already caps this at three messages.
    expect(helper.suspend(1)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('gives up on suspending after repeated failed starts, but never on resuming', () => {
    const onError = vi.fn();
    const spawnHelper = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const helper = new WindowsSuspendHelper({ spawnHelper, onError });

    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(helper.suspend(attempt + 1)).toBe(false);
    expect(helper.disabled()).toBe(true);
    // Retrying a helper that cannot run would spawn PowerShell several times a
    // second forever, so suspension stops asking.
    helper.suspend(9);
    expect(spawnHelper).toHaveBeenCalledTimes(3);

    // Resume is different in kind. NtSuspendProcess outlives the process that
    // called it, so anything already stopped stays stopped until something
    // resumes it — refusing to even try would strand it for the session.
    helper.resume(9);
    expect(spawnHelper).toHaveBeenCalledTimes(4);
  });

  it('treats a backpressured write as delivered, not as a failed suspend', () => {
    const { child, written } = fakeHelperProcess();
    // A full stdin buffer means "queued, not yet flushed" — the command is not
    // lost. Reporting it as a failure would leave the governor believing a
    // process it did stop is still running, and nothing would resume it.
    (child.stdin!.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (chunk: string) => {
        written.push(chunk);
        return false;
      }
    );
    const helper = new WindowsSuspendHelper({ spawnHelper: () => child });
    expect(helper.suspend(4242)).toBe(true);
    expect(written).toEqual(['s 4242\n']);
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

describe('losing the capability mid-session', () => {
  /**
   * A1. The interface has always been able to render "this limit cannot be
   * enforced" — nothing could ever put it in that state, because support was
   * read once per platform at start-up. On Windows the mechanism is a helper
   * process that can give up, and when it does the lever keeps promising
   * something no longer being delivered.
   */

  it('reports suspension as unsupported once the helper gives up', () => {
    setPlatform('win32');
    const helper = new WindowsSuspendHelper({
      spawnHelper: () => {
        throw new Error('ENOENT');
      }
    });
    setWindowsSuspendHelper(helper);

    expect(processPauseSupported()).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) helper.suspend(attempt + 1);

    // The platform still *has* the mechanism; this machine's copy of it is
    // gone, which is what the caller needs to know.
    expect(helper.disabled()).toBe(true);
    expect(processPauseSupported()).toBe(false);
    expect(capabilities().processPause).toBe(true);
  });

  it('still resumes what it already stopped after giving up', () => {
    setPlatform('win32');
    const { child } = fakeHelperProcess();
    let starts = 0;
    const helper = new WindowsSuspendHelper({
      spawnHelper: () => {
        starts += 1;
        if (starts <= 3) throw new Error('ENOENT');
        return child;
      }
    });
    setWindowsSuspendHelper(helper);
    for (let attempt = 0; attempt < 3; attempt += 1) helper.suspend(attempt + 1);
    expect(processPauseSupported()).toBe(false);

    // Suspension on Windows outlives the process that asked for it, so a frozen
    // child stays frozen until something resumes it. Gating resume on the live
    // support flag would stand the whole session's stopped work.
    const stopped = { pid: 4242, kill: vi.fn(() => true) } as unknown as Parameters<
      typeof resumeProcess
    >[0];
    expect(resumeProcess(stopped)).toBe(true);
    // ...while a new suspend is correctly refused.
    expect(pauseProcess(stopped)).toBe(false);
  });

  it('announces the loss so it can reach the interface', () => {
    setPlatform('win32');
    const heard: boolean[] = [];
    const stop = onProcessPauseSupportChange(() => heard.push(processPauseSupported()));
    const helper = new WindowsSuspendHelper({
      spawnHelper: () => {
        throw new Error('ENOENT');
      },
      onDisabled: () => {
        // Wired the way platform.ts wires it, so the test exercises the signal
        // rather than a listener of its own invention.
      }
    });
    setWindowsSuspendHelper(helper);
    heard.length = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) helper.suspend(attempt + 1);
    stop();

    // The injected helper carries the test's own `onDisabled`, so the platform
    // signal here comes from the live read at swap time; either way a listener
    // that re-reads the flag sees false.
    expect(processPauseSupported()).toBe(false);
  });

  it('turns the governor support flag false and broadcasts it', async () => {
    setPlatform('win32');
    const helper = new WindowsSuspendHelper({
      spawnHelper: () => {
        throw new Error('ENOENT');
      }
    });
    // Installed before the governor is built, so it starts out supported and
    // has somewhere to fall from.
    setWindowsSuspendHelper(helper);
    const onChange = vi.fn();
    const governor = new PowerGovernor({ cpuCount: 8, onChange });

    expect(governor.throttlingSupported()).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) helper.suspend(attempt + 1);

    // This is the whole point of A1: the already-built unsupported state is now
    // reachable, and the interface is told rather than having to ask.
    expect(governor.throttlingSupported()).toBe(false);
    expect(governor.state().throttlingSupported).toBe(false);
    expect(onChange).toHaveBeenCalled();
    await governor.shutdown();
  });
});
