// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRestitchPreparer } from '../apps/web/src/team/catalog-updater/useRestitchPreparer';
import { RECOVERY_CHANGED } from '../apps/web/src/api/recovery';
const state = vi.hoisted(() => ({
  native: true,
  actorBound: false,
  automatic: undefined as { actorId: string; sessionKey: string } | undefined,
  ensure: vi.fn(),
  status: vi.fn(),
  connection: 'connected',
  instanceId: 'agent-one'
}));
vi.mock('../apps/web/src/AgentContext', () => ({
  useOptionalAgent: () => ({
    capabilities: state.native
      ? [
          'team-background-recovery',
          ...(state.actorBound ? ['team-background-recovery-actor-bound'] : [])
        ]
      : [],
    connection: state.connection,
    lastKnownAgent: { instanceId: state.instanceId }
  })
}));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));
vi.mock('../apps/web/src/api/recovery', () => ({
  RECOVERY_CHANGED: 'soty.recovery.changed',
  backgroundRecoveryStatus: (team: string) => state.status(team),
  ensureBackgroundRecovery: (...args: unknown[]) => state.ensure(...args)
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.status.mockReset();
  state.native = true;
  state.actorBound = false;
  state.automatic = undefined;
  state.ensure.mockReset();
  state.connection = 'connected';
  state.instanceId = 'agent-one';
});
function controller() {
  const claim = vi.fn(async () => null);
  const client = {
    claimRestitchJob: claim,
    heartbeatRestitchJob: vi.fn(),
    completeRestitchJob: vi.fn(async () => true),
    startProcess: vi.fn(),
    cancelProcess: vi.fn()
  };
  const hook = renderHook(() =>
    useRestitchPreparer({
      teamId: 'synthetic',
      enabled: state.connection === 'connected',
      client,
      automatic: state.automatic
    })
  );
  return { claim, client, result: hook.result, rerender: hook.rerender, unmount: hook.unmount };
}
function fixture() {
  return controller().claim;
}
describe('one restitch executor owner', () => {
  it('automatically enrolls old user-off settings and never lends the browser a competing claim', async () => {
    vi.useFakeTimers();
    state.actorBound = true;
    state.automatic = { actorId: 'actor', sessionKey: 'session' };
    state.status.mockResolvedValue({ enabled: false, automaticSetup: 'eligible' });
    state.ensure.mockResolvedValue({ enabled: true, automaticSetup: 'ready' });
    let view!: ReturnType<typeof controller>;
    await act(async () => {
      view = controller();
    });
    expect(state.ensure).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(view.claim).not.toHaveBeenCalled();
    expect(view.result.current.backgroundStatus).toMatchObject({ enabled: true });
  });

  it('bounds a hung ownership read and automatically retries without issuing browser work', async () => {
    vi.useFakeTimers();
    state.status
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ enabled: true });
    let view!: ReturnType<typeof controller>;
    await act(async () => {
      view = controller();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    expect(state.status).toHaveBeenCalledTimes(2);
    expect(view.claim).not.toHaveBeenCalled();
  });

  it('fences setup replies after an actor/session change and keeps retirement blocked', async () => {
    vi.useFakeTimers();
    state.actorBound = true;
    state.automatic = { actorId: 'old', sessionKey: 'old' };
    state.status
      .mockResolvedValueOnce({ enabled: false, automaticSetup: 'eligible' })
      .mockResolvedValue({ enabled: false, automaticSetup: 'retiring' });
    let finish!: (value: unknown) => void;
    state.ensure.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    let view!: ReturnType<typeof controller>;
    await act(async () => {
      view = controller();
    });
    const scope = state.ensure.mock.calls[0][1];
    await act(async () => {
      state.automatic = { actorId: 'new', sessionKey: 'new' };
      view.rerender();
    });
    expect(scope.isCurrent()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
    await act(async () => {
      finish({ enabled: true, automaticSetup: 'ready' });
    });
    expect(view.result.current.backgroundStatus).toMatchObject({ automaticSetup: 'retiring' });
    expect(state.ensure).toHaveBeenCalledOnce();
    expect(view.claim).not.toHaveBeenCalled();
  });
  it('returns a handoff received after the browser executor stopped instead of stranding its lease', async () => {
    vi.useFakeTimers();
    state.native = false;
    const view = controller();
    let resolveClaim!: (value: never) => void;
    view.claim.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveClaim = resolve;
        })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    view.unmount();
    await act(async () => {
      resolveClaim({ jobId: 'job', operationId: 'operation', leaseToken: 'lease' } as never);
    });
    expect(view.client.startProcess).not.toHaveBeenCalled();
    expect(view.client.completeRestitchJob).toHaveBeenCalledWith({
      jobId: 'job',
      leaseToken: 'lease',
      outcome: 'failed',
      errorCode: 'PROCESS_CANCELED'
    });
  });
  it('retries a transient ownership read failure before resuming browser claims', async () => {
    vi.useFakeTimers();
    state.status
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValue({ enabled: false });
    let claim!: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(state.status).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim).toHaveBeenCalledOnce();
  });
  it('rechecks ownership before browser claims after reconnect with unchanged capabilities', async () => {
    vi.useFakeTimers();
    state.status.mockResolvedValueOnce({ enabled: false }).mockResolvedValue({ enabled: true });
    let view!: ReturnType<typeof controller>;
    await act(async () => {
      view = controller();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(view.claim).toHaveBeenCalledOnce();
    await act(async () => {
      state.connection = 'disconnected';
      view.rerender();
    });
    await act(async () => {
      state.connection = 'connected';
      view.rerender();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(state.status).toHaveBeenCalledTimes(2);
    expect(view.claim).toHaveBeenCalledOnce();
  });
  it('rechecks ownership when a different native instance connects', async () => {
    vi.useFakeTimers();
    state.status.mockResolvedValueOnce({ enabled: false }).mockResolvedValue({ enabled: true });
    let view!: ReturnType<typeof controller>;
    await act(async () => {
      view = controller();
    });
    await act(async () => {
      state.instanceId = 'agent-two';
      view.rerender();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(state.status).toHaveBeenCalledTimes(2);
    expect(view.claim).not.toHaveBeenCalled();
  });
  it.each(['storage', 'focus'])(
    'refreshes ownership on %s from another tab or return to this tab',
    async kind => {
      vi.useFakeTimers();
      state.status.mockResolvedValueOnce({ enabled: false }).mockResolvedValue({ enabled: true });
      let claim!: ReturnType<typeof fixture>;
      await act(async () => {
        claim = fixture();
      });
      await act(async () => {
        window.dispatchEvent(
          kind === 'storage'
            ? new StorageEvent('storage', { key: RECOVERY_CHANGED, newValue: 'synthetic-change' })
            : new Event('focus')
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });
      expect(state.status).toHaveBeenCalledTimes(2);
      expect(claim).not.toHaveBeenCalled();
    }
  );
  it('ignores a stale disabled response after a newer native-owner confirmation', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: { enabled: boolean }) => void;
    state.status
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue({ enabled: true });
    let claim!: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      window.dispatchEvent(new Event(RECOVERY_CHANGED));
    });
    await act(async () => {
      resolveOld({ enabled: false });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(claim).not.toHaveBeenCalled();
  });
  it('pauses browser claims while ownership is being rechecked', async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: { enabled: boolean }) => void;
    state.status.mockResolvedValueOnce({ enabled: false }).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRefresh = resolve;
        })
    );
    let claim!: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      window.dispatchEvent(new Event(RECOVERY_CHANGED));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(claim).not.toHaveBeenCalled();
    await act(async () => {
      resolveRefresh({ enabled: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim).not.toHaveBeenCalled();
  });
  it('ignores an obsolete read failure after the browser owner is confirmed', async () => {
    vi.useFakeTimers();
    let rejectOld!: (reason: Error) => void;
    state.status
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          })
      )
      .mockResolvedValue({ enabled: false });
    let claim!: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      window.dispatchEvent(new Event(RECOVERY_CHANGED));
    });
    await act(async () => {
      rejectOld(new Error('old read failed'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim).toHaveBeenCalledOnce();
  });
  it('does not poll for work while the native owner is enabled, then resumes after explicit disabling', async () => {
    vi.useFakeTimers();
    state.status.mockResolvedValue({ enabled: true });
    let claim: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(claim!).not.toHaveBeenCalled();
    state.status.mockResolvedValue({ enabled: false });
    await act(async () => {
      window.dispatchEvent(new Event(RECOVERY_CHANGED));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim!).toHaveBeenCalledOnce();
  });
  it('does not race the native owner when status cannot be read', async () => {
    vi.useFakeTimers();
    state.status.mockRejectedValue(new Error('offline'));
    let claim: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(claim!).not.toHaveBeenCalled();
  });
  it('preserves the legacy executor for an agent without the capability', async () => {
    vi.useFakeTimers();
    state.native = false;
    let claim: ReturnType<typeof fixture>;
    await act(async () => {
      claim = fixture();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(claim!).toHaveBeenCalledOnce();
    expect(state.status).not.toHaveBeenCalled();
  });
});
