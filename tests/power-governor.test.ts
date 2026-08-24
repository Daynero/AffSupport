import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerGovernor } from '../apps/agent/src/power/governor.js';
import { POWER_LIMIT_MAX, POWER_LIMIT_MIN } from '../packages/shared/src/types.js';

/**
 * A stand-in for a spawned tool. `kill` records the signals it receives, which
 * is how the duty cycle and the safety invariants are observed — the real
 * mechanism is SIGSTOP/SIGCONT delivery, so the signal log *is* the behaviour.
 */
function fakeChild(pid = 4242) {
  const signals: string[] = [];
  const child = {
    pid,
    kill: vi.fn((signal: string) => {
      signals.push(signal);
      return true;
    }),
    once: vi.fn()
  } as unknown as ChildProcess;
  return { child, signals };
}

function governor(options: Partial<ConstructorParameters<typeof PowerGovernor>[0]> = {}) {
  return new PowerGovernor({ cpuCount: 10, pauseSupported: true, ...options });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cpu budget', () => {
  it('scales the thread budget with the limit', () => {
    const power = governor();
    void power.setLimit(40);
    expect(power.budget().threadBudget).toBe(4);
    void power.setLimit(50);
    expect(power.budget().threadBudget).toBe(5);
  });

  it('never floors the thread budget to zero', () => {
    // 20% of two cores rounds to 0. A job with no threads never finishes, so
    // the floor is what keeps throughput non-zero at the minimum setting.
    const power = governor({ cpuCount: 2 });
    void power.setLimit(POWER_LIMIT_MIN);
    expect(power.budget().threadBudget).toBe(1);
  });

  it('is indistinguishable from a build without the throttle when unrestricted', () => {
    const power = governor();
    const budget = power.budget();
    // Null, not a derived-but-equal value: at 100% the spawned command line has
    // to be byte-identical to what shipped before. A `-threads <cores>` flag
    // FFmpeg never received, or whisper jumping 8 → 10 threads, would be a
    // regression for every user who never opens the control.
    expect(budget.threadBudget).toBeNull();
    expect(budget.priority).toBeNull();
    expect(budget.dutyOnFraction).toBe(1);
    expect(power.scaleTimeout(90_000)).toBe(90_000);
  });

  it('lowers priority only while a limit is in force', () => {
    const power = governor();
    void power.setLimit(40);
    expect(power.budget().priority).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it('stretches wall-clock deadlines in step with the duty cycle', () => {
    const power = governor();
    void power.setLimit(20);
    // A 90 s render budget at 20% must become 450 s, or throttling would abort
    // work for obeying the user's own limit.
    expect(power.scaleTimeout(90_000)).toBe(450_000);
    void power.setLimit(50);
    expect(power.scaleTimeout(90_000)).toBe(180_000);
  });

  it('reports the mode from the limit', () => {
    const power = governor();
    expect(power.state().mode).toBe('unrestricted');
    void power.setLimit(99);
    expect(power.state().mode).toBe('limited');
  });

  it('clamps whatever it is handed', async () => {
    const power = governor();
    expect(await power.setLimit(500)).toBe(POWER_LIMIT_MAX);
    expect(await power.setLimit(1)).toBe(POWER_LIMIT_MIN);
  });
});

describe('duty cycling', () => {
  it('sends no signals at all when unrestricted', () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    vi.advanceTimersByTime(2_000);
    // Not "suspending for 0 ms": genuinely inactive, so an unthrottled encode
    // costs nothing extra.
    expect(signals).toEqual([]);
  });

  it('suspends and resumes on a period once limited', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(50);

    vi.advanceTimersByTime(600);
    expect(signals).toContain('SIGSTOP');
    expect(signals).toContain('SIGCONT');
  });

  it('holds the on-window above a scheduling quantum at the floor', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(POWER_LIMIT_MIN);

    // 20% of a 200 ms period is 40 ms, below the floor; the cycler must still
    // give the process a schedulable slice or it makes no progress at all.
    vi.advanceTimersByTime(1_000);
    expect(signals.filter(signal => signal === 'SIGCONT').length).toBeGreaterThan(0);
  });

  it('stops cycling when the limit returns to unrestricted', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(40);
    vi.advanceTimersByTime(600);
    await power.setLimit(POWER_LIMIT_MAX);
    const afterLift = signals.length;
    vi.advanceTimersByTime(2_000);
    // Whatever it did while limited, raising the lever must leave the process
    // running free — not stopped, and not still being toggled.
    expect(signals.length).toBe(afterLift);
    expect(signals.at(-1)).toBe('SIGCONT');
  });
});

describe('safety invariants', () => {
  it('resumes and then kills every child still registered at shutdown', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    vi.advanceTimersByTime(600);

    await power.shutdown();
    // Both halves matter, and in this order. A child left stopped outlives the
    // agent and never makes progress again; a child left *running* outlives it
    // holding the machine at full speed, with nothing attached to it that could
    // report or stop it — every tool has already had its graceful shutdown by
    // the time this runs, so anything still here is a leak.
    expect(signals.slice(-2)).toEqual(['SIGCONT', 'SIGKILL']);
  });

  it('resumes a suspended child when it is released', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    vi.advanceTimersByTime(600);

    power.release(child);
    expect(signals.at(-1)).toBe('SIGCONT');
    expect(power.activeChildren()).toBe(0);
  });

  it('never signals a child after it has been released', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    power.release(child);
    const afterRelease = signals.length;

    vi.advanceTimersByTime(2_000);
    // The OS may have recycled that PID onto an unrelated process by now.
    expect(signals.length).toBe(afterRelease);
  });

  it('shares one budget between concurrent children', async () => {
    const power = governor();
    const first = fakeChild(1);
    const second = fakeChild(2);
    power.register(first.child, { toolId: 'compressor' });
    power.register(second.child, { toolId: 'transcription' });
    await power.setLimit(50);

    // 50% means 50% together, not 50% each: there is one budget, and both
    // children are inside it.
    expect(power.budget().threadBudget).toBe(5);
    expect(power.activeChildren()).toBe(2);
  });

  it('does not throttle when the platform cannot suspend', async () => {
    vi.useFakeTimers();
    const power = governor({ pauseSupported: false });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);

    vi.advanceTimersByTime(2_000);
    expect(signals).toEqual([]);
    expect(power.state().throttlingSupported).toBe(false);
  });
});

describe('hold protocol', () => {
  it('keeps a held child suspended through the duty cycle', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(50);

    const release = power.hold(child, 'estimate-priority');
    signals.length = 0;
    vi.advanceTimersByTime(1_000);

    // The cycler must not resume a process another subsystem deliberately
    // stopped; that is exactly how estimate prioritization would break.
    expect(signals).not.toContain('SIGCONT');
    release();
  });

  it('suspends immediately when a hold is taken at full power', () => {
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });

    const release = power.hold(child, 'estimate-priority');
    expect(signals).toContain('SIGSTOP');
    release();
    expect(signals.at(-1)).toBe('SIGCONT');
  });

  it('resumes and pins a child before termination', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    power.hold(child, 'estimate-priority');

    power.resumeForTermination(child);
    expect(signals.at(-1)).toBe('SIGCONT');

    signals.length = 0;
    vi.advanceTimersByTime(2_000);
    // SIGTERM is not delivered to a stopped process, so the cycler must leave
    // this one alone until it exits — otherwise a cancel silently falls through
    // to SIGKILL and the tool never finalizes its output.
    expect(signals).not.toContain('SIGSTOP');
  });

  it('takes a child that survived its own termination back under the limit', async () => {
    vi.useFakeTimers();
    const power = governor();
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(20);
    power.resumeForTermination(child);

    signals.length = 0;
    // A process can outlive the signal meant to end it: SIGTERM handled, an
    // encode still flushing, a kill that never landed. Pinning it resumed
    // forever would quietly exempt it from the limit for the rest of the
    // session, and the lever would look like it had stopped working.
    vi.advanceTimersByTime(60_000);
    expect(signals).toContain('SIGSTOP');
  });

  it('reports whether a hold actually stopped the child', () => {
    const power = governor();
    const { child } = fakeChild();
    expect(power.isSuspended(child)).toBe(false);

    power.register(child, { toolId: 'compressor' });
    const release = power.hold(child, 'estimate-priority');
    expect(power.isSuspended(child)).toBe(true);
    release();
    expect(power.isSuspended(child)).toBe(false);
  });

  it('reports a hold that could not be delivered as not suspended', () => {
    // The compressor hands the machine to prioritized estimates only when the
    // encode is genuinely stopped. A process that has already gone cannot be —
    // and answering "held" there would run both at once while believing one of
    // them was paused.
    const power = governor();
    const { child } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    (child.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => false);

    power.hold(child, 'estimate-priority');
    expect(power.isSuspended(child)).toBe(false);
  });
});

describe('state snapshot', () => {
  it('reports work as active when a tool is busy without a child yet', () => {
    // A job in `preparing-images` has no child process, but telling the user
    // Soty is idle while the compressor UI says "running" is simply wrong.
    const power = governor({ busy: () => true });
    expect(power.state().sample.activity).toBe('active');
  });

  it('reports idle with no children and nothing busy', () => {
    const power = governor();
    const state = power.state();
    expect(state.sample.activity).toBe('idle');
    expect(state.activeChildren).toBe(0);
  });

  it('starts with no consumption figure rather than a fabricated zero', () => {
    expect(governor().state().sample.availability).toBe('warming-up');
  });
});

describe('persistence coupling', () => {
  it('does not apply a limit it could not persist', async () => {
    const power = governor({
      persist: async () => {
        throw new Error('EROFS');
      }
    });
    await expect(power.setLimit(40)).rejects.toThrow('EROFS');
    // The lever must never show a value that will not survive a restart.
    expect(power.limitPercent()).toBe(POWER_LIMIT_MAX);
  });

  it('adopts a stored limit without re-persisting it', () => {
    const persist = vi.fn(async () => {});
    const power = governor({ persist });
    power.adoptPersistedLimit(40, '2026-08-20T09:00:00.000Z');
    expect(power.limitPercent()).toBe(40);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('the termination pin ages on the wall clock', () => {
  /**
   * A6. The pin used to be counted in duty periods, ticked by the cycler. The
   * cycler stops for exactly the reasons that leave a pin outstanding — the
   * limit going back to unrestricted, the last other child ending — so a pin
   * could stop ageing at the moment nothing was left to age it, and a child
   * that survived its own kill stayed exempt from the limit for the session.
   *
   * The two clocks here are separate on purpose: vitest's fake timers drive the
   * cycler, and the injected `now` drives the pin. Advancing one without the
   * other is precisely the situation the counter could not represent.
   */

  function clock(start = 1_000_000) {
    let at = start;
    return {
      now: () => at,
      advance: (ms: number) => {
        at += ms;
      }
    };
  }

  it('lapses across a stretch when the cycler was not running', async () => {
    vi.useFakeTimers();
    const time = clock();
    const power = governor({ now: time.now });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(40);

    power.resumeForTermination(child);
    vi.advanceTimersByTime(600);
    time.advance(600);
    // Pinned: a tool being terminated must be left running so SIGTERM reaches
    // it and it can finalize its output.
    expect(signals).not.toContain('SIGSTOP');

    // The lever goes back to unrestricted, which stops the cycler. Wall time
    // passes; no duty period does. A pin counted in periods would not age at
    // all here.
    await power.setLimit(POWER_LIMIT_MAX);
    time.advance(11_000);
    await power.setLimit(40);

    signals.length = 0;
    vi.advanceTimersByTime(600);
    // The child outlived the signal meant to end it, so it is back under the
    // limit rather than exempt for the rest of the session.
    expect(signals).toContain('SIGSTOP');
  });

  it('still holds inside the window', async () => {
    vi.useFakeTimers();
    const time = clock();
    const power = governor({ now: time.now });
    const { child, signals } = fakeChild();
    power.register(child, { toolId: 'compressor' });
    await power.setLimit(40);

    power.resumeForTermination(child);
    await power.setLimit(POWER_LIMIT_MAX);
    time.advance(2_000);
    await power.setLimit(40);

    signals.length = 0;
    vi.advanceTimersByTime(600);
    // Two seconds is inside the escalation window; stopping the child here is
    // the bug the pin exists to prevent.
    expect(signals).not.toContain('SIGSTOP');
  });
});
