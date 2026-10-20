// @vitest-environment jsdom
import React from 'react';
import { spaceTariffApi } from '../apps/web/src/api/team';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseWorkspaceRecovery,
  type WorkspaceRecovery
} from '../packages/shared/src/team/recovery';
import { UpdaterResumeNotice } from '../apps/web/src/team/tariffs/UpdaterResumeNotice';
const TEAM = '34000000-0000-4000-8000-000000000001';
const state = vi.hoisted(() => ({
  allowed: true,
  tariff: { updaterPausedByTariff: false, recovery: null as WorkspaceRecovery | null }
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({
  useTeam: () => ({ can: () => state.allowed })
}));
vi.mock('../apps/web/src/team/tariffs/useSpaceAccess', () => ({
  useOptionalSpaceAccess: () => ({
    access: { teams: [{ teamId: TEAM, tariff: state.tariff }] },
    recheck: vi.fn()
  })
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.allowed = true;
  state.tariff = { updaterPausedByTariff: false, recovery: null };
});
function recovery(status: WorkspaceRecovery['state']): WorkspaceRecovery {
  return {
    id: TEAM,
    epoch: 1,
    state: status,
    registeredAt: '2026-10-20T10:00:00Z',
    lastProgressAt: '2026-10-20T10:00:00Z',
    counts: {
      pending: 0,
      running: 1,
      waiting: 0,
      resumed: 0,
      completed: 0,
      skipped: 0,
      blocked: 0
    },
    reasons: [],
    canManageRecovery: true
  };
}
describe('recovery notice', () => {
  it('shows queued work as restoring without a manual enable button or completed message', () => {
    state.tariff.recovery = recovery('running');
    const resume = vi.fn();
    render(<UpdaterResumeNotice teamId={TEAM} resume={resume} />);
    expect(screen.getByText('Restoring background work…')).toBeTruthy();
    expect(screen.queryByText('Turn on')).toBeNull();
    expect(resume).not.toHaveBeenCalled();
  });
  it('shows a concrete dependency for partial recovery and a route to settings', () => {
    state.tariff.recovery = {
      ...recovery('partial'),
      reasons: [{ code: 'waiting_drive', count: 1, action: 'drive' }]
    };
    render(<UpdaterResumeNotice teamId={TEAM} />);
    expect(screen.getByText('Some work still needs attention.')).toBeTruthy();
    expect(screen.getByText('Reconnect Google Drive in space settings.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Space settings' })).toBeTruthy();
  });
  it('does not claim completion when recovery data is absent and keeps permission boundaries', () => {
    state.tariff.updaterPausedByTariff = true;
    const view = render(<UpdaterResumeNotice teamId={TEAM} />);
    expect(
      screen.getByText('Recovery is not confirmed. Check the operation before retrying.')
    ).toBeTruthy();
    state.allowed = false;
    view.rerender(<UpdaterResumeNotice teamId={TEAM} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('retries only explicitly retryable recovery and does not announce completion', async () => {
    state.tariff.recovery = {
      ...recovery('partial'),
      reasons: [{ code: 'retry_exhausted', count: 1, action: 'retry' }]
    };
    const retry = vi.spyOn(spaceTariffApi, 'retryRecovery').mockResolvedValue(true);
    render(<UpdaterResumeNotice teamId={TEAM} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(TEAM));
    expect(screen.queryByText('Background work restored.')).toBeNull();
  });
  it('does not describe manually skipped work as resumed', () => {
    const value = recovery('completed');
    value.counts.skipped = 1;
    state.tariff.recovery = {
      ...value,
      reasons: [{ code: 'manually_disabled', count: 1, action: 'none' }]
    };
    render(<UpdaterResumeNotice teamId={TEAM} />);
    expect(screen.getByText('Recovery finished. Manually stopped work stayed off.')).toBeTruthy();
    expect(screen.queryByText('Background work has resumed.')).toBeNull();
  });
  it('validates closed states, bounded counts and malformed recovery projections', () => {
    expect(parseWorkspaceRecovery(recovery('running'))).toEqual(recovery('running'));
    expect(parseWorkspaceRecovery({ ...recovery('running'), state: 'uploaded_secret' })).toBeNull();
    expect(
      parseWorkspaceRecovery({
        ...recovery('running'),
        counts: { ...recovery('running').counts, running: -1 }
      })
    ).toBeNull();
  });
});
