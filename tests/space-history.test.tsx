// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAuditEventSummary } from '../apps/web/src/api/team';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { HistoryDialog } from '../apps/web/src/team/workspace/HistoryDialog';
import { adminAuthStub } from './support/auth-stub';

/** The space's history, readable (024): days, one line an event, problems only badged. */

const TEAM = '24000000-0000-4000-8000-000000000001';
// Keep all events within one day even when CI runs across midnight.
const now = new Date(2026, 10, 4, 12, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

function event(overrides: Partial<TeamAuditEventSummary>): TeamAuditEventSummary {
  return {
    id: crypto.randomUUID(),
    actorLabel: 'Olena',
    actorId: 'someone-else',
    action: 'material.uploaded',
    target: {},
    result: 'succeeded',
    errorCode: null,
    occurredAt: at(1),
    subjectLabel: 'IN 40.mp4',
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  localStorage.setItem('language', 'en');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

function renderHistory(events: TeamAuditEventSummary[]) {
  const auth = adminAuthStub();
  render(
    <AuthContextOverride value={auth}>
      <HistoryDialog
        teamId={TEAM}
        client={{ listAuditEvents: vi.fn().mockResolvedValue(events) }}
        onClose={vi.fn()}
      />
    </AuthContextOverride>
  );
  return auth;
}

describe('the space history', () => {
  it('keeps older work readable across people, catalog and task events', async () => {
    renderHistory([
      event({ action: 'membership.updated', result: 'denied', subjectLabel: null }),
      event({ action: 'drive.resynced', result: 'failed', actorLabel: null, occurredAt: at(1441) }),
      event({ action: 'material.upload', subjectLabel: 'offer_v2_catalog', occurredAt: at(2881) }),
      event({ action: 'task.assigned', target: { to: 'Buyer' }, occurredAt: at(2882) }),
      event({ action: 'task.assigned', target: {}, occurredAt: at(2883) }),
      event({
        action: 'task.file_attached',
        subjectLabel: 'Brief.pdf',
        target: {},
        occurredAt: at(2884)
      }),
      event({
        action: 'future.safe_action',
        subjectLabel: null,
        occurredAt: '2025-11-01T12:00:00Z'
      })
    ]);
    expect(await screen.findByRole('region', { name: 'Yesterday' })).toBeTruthy();
    expect(screen.getByText('future.safe_action')).toBeTruthy();
    expect(screen.getByText('Brief.pdf')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Former member')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'People' }));
    expect(screen.queryByText('Brief.pdf')).toBeNull();
  });
  it('pages earlier events with the oldest cursor and retains loaded events after a read failure', async () => {
    const first = Array.from({ length: 50 }, (_, n) =>
      event({ subjectLabel: `Creative ${n}`, occurredAt: at(n) })
    );
    const client = {
      listAuditEvents: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce([event({ subjectLabel: 'Older', occurredAt: at(80) })])
    };
    render(
      <AuthContextOverride value={adminAuthStub()}>
        <HistoryDialog teamId={TEAM} client={client} onClose={vi.fn()} />
      </AuthContextOverride>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show earlier' }));
    await waitFor(() => expect(client.listAuditEvents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Show earlier' }).getAttribute('aria-busy')
      ).not.toBe('true')
    );
    expect(screen.getByText('Creative 0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('Older')).toBeTruthy();
    expect(client.listAuditEvents.mock.calls[2]).toEqual([
      TEAM,
      { limit: 50, before: first.at(-1)!.occurredAt }
    ]);
    expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
  });
  it('says the work as lines under the day, folds repeats and badges only problems', async () => {
    renderHistory([
      event({
        action: 'task.status_changed',
        target: { task_id: 't1', task_title: 'Launch GlucoSoft', to: 'done' },
        subjectLabel: 'Launch GlucoSoft'
      }),
      event({ action: 'material.uploaded', occurredAt: at(2) }),
      event({ action: 'material.uploaded', occurredAt: at(3) }),
      event({ action: 'operation.canceled', result: 'canceled', occurredAt: at(4) })
    ]);
    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getByText('Task moved to Done')).toBeTruthy();
    expect(within(today).getByRole('link', { name: 'Launch GlucoSoft' })).toBeTruthy();
    expect(within(today).getByText('×2')).toBeTruthy();
    expect(within(today).queryByText('Succeeded')).toBeNull();
    expect(within(today).getByText('Canceled')).toBeTruthy();
  });

  it('narrows to launches, and to what I did', async () => {
    const auth = renderHistory([
      event({ action: 'agent.run_added', target: { agent: 'v31-434', note: 'GlucoSoft | PL' } }),
      event({ action: 'material.uploaded', occurredAt: at(2) })
    ]);
    await screen.findByText('Launch marked on v31-434');
    fireEvent.click(screen.getByRole('radio', { name: 'Launches' }));
    expect(screen.queryByText('IN 40.mp4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Only mine' }));
    expect(screen.queryByText('Launch marked on v31-434')).toBeNull();
    expect(auth).toBeTruthy();
  });
});
