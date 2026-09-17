// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAuditEventSummary } from '../apps/web/src/api/team';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { HistoryDialog } from '../apps/web/src/team/workspace/HistoryDialog';
import { adminAuthStub } from './support/auth-stub';

/** The space's history, readable (024): days, one line an event, problems only badged. */

const TEAM = '24000000-0000-4000-8000-000000000001';
const now = Date.now();
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

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
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
