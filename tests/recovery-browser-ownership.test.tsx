// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRestitchPreparer } from '../apps/web/src/team/catalog-updater/useRestitchPreparer';
import { RECOVERY_CHANGED } from '../apps/web/src/api/recovery';
const state = vi.hoisted(() => ({ native: true, status: vi.fn() }));
vi.mock('../apps/web/src/AgentContext', () => ({
  useOptionalAgent: () => ({ capabilities: state.native ? ['team-background-recovery'] : [] })
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
});
function fixture() {
  const claim = vi.fn(async () => null);
  const client = {
    claimRestitchJob: claim,
    heartbeatRestitchJob: vi.fn(),
    completeRestitchJob: vi.fn(),
    startProcess: vi.fn(),
    cancelProcess: vi.fn()
  };
  renderHook(() => useRestitchPreparer({ teamId: 'synthetic', enabled: true, client }));
  return claim;
}
describe('one restitch executor owner', () => {
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
