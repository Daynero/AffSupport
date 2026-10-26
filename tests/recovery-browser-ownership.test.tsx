// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRestitchPreparer } from '../apps/web/src/team/catalog-updater/useRestitchPreparer';
import { RECOVERY_CHANGED } from '../apps/web/src/api/recovery';
const state = vi.hoisted(() => ({
  native: true,
  status: vi.fn(),
  connection: 'connected',
  instanceId: 'agent-one'
}));
vi.mock('../apps/web/src/AgentContext', () => ({
  useOptionalAgent: () => ({
    capabilities: state.native ? ['team-background-recovery'] : [],
    connection: state.connection,
    lastKnownAgent: { instanceId: state.instanceId }
  })
}));
vi.mock('../apps/web/src/api/useAgentEventStream', () => ({ useAgentEventStream: () => {} }));
vi.mock('../apps/web/src/api/recovery', () => ({
  RECOVERY_CHANGED: 'soty.recovery.changed',
  backgroundRecoveryStatus: (team: string) => state.status(team)
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.status.mockReset();
  state.native = true;
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
      client
    })
  );
  return { claim, client, rerender: hook.rerender, unmount: hook.unmount };
}
function fixture() {
  return controller().claim;
}
describe('one restitch executor owner', () => {
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
