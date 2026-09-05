import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachInactivityWatchdog } from '../apps/agent/src/whisper/transcriber.js';

/** Just enough of a child for the watchdog: signals it was sent, and a close it can emit. */
function fakeChild() {
  const emitter = new EventEmitter();
  const signals: string[] = [];
  const child = Object.assign(emitter, {
    kill: (signal?: string) => {
      signals.push(signal ?? 'SIGTERM');
      return true;
    }
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, signals, close: () => emitter.emit('close', 0) };
}

describe('inactivity watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends a silent child and escalates when it ignores the first signal', () => {
    const { child, signals } = fakeChild();
    attachInactivityWatchdog(
      child,
      () => false,
      () => 1_000
    );
    vi.advanceTimersByTime(999);
    expect(signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(10_000);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('starts the window again on every chunk of output', () => {
    const { child, signals } = fakeChild();
    const watchdog = attachInactivityWatchdog(
      child,
      () => false,
      () => 1_000
    );
    for (let tick = 0; tick < 5; tick += 1) {
      vi.advanceTimersByTime(800);
      watchdog.reset();
    }
    expect(signals).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('waits out a pause instead of killing a child that is held on purpose', () => {
    const { child, signals } = fakeChild();
    let paused = true;
    attachInactivityWatchdog(
      child,
      () => paused,
      () => 1_000
    );
    vi.advanceTimersByTime(5_000);
    expect(signals).toEqual([]);
    paused = false;
    vi.advanceTimersByTime(1_000);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('stops watching once the child has closed', () => {
    const { child, signals, close } = fakeChild();
    attachInactivityWatchdog(
      child,
      () => false,
      () => 1_000
    );
    close();
    vi.advanceTimersByTime(20_000);
    expect(signals).toEqual([]);
  });

  it('asks for the budget on every arm, so a changed limit is honoured mid-run', () => {
    const { child, signals } = fakeChild();
    let budget = 1_000;
    const watchdog = attachInactivityWatchdog(
      child,
      () => false,
      () => budget
    );
    budget = 5_000;
    watchdog.reset();
    vi.advanceTimersByTime(4_999);
    expect(signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(signals).toEqual(['SIGTERM']);
  });
});
