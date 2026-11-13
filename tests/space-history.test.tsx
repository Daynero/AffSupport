// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAuditEventSummary } from '../apps/web/src/api/team';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { HistoryDialog } from '../apps/web/src/team/workspace/HistoryDialog';
import { TeamAuditPanel } from '../apps/web/src/team/members/TeamAuditPanel';
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

  it('loads an older page by its cursor while keeping the current day visible', async () => {
    const first = Array.from({ length: 50 }, (_, index) => event({ occurredAt: at(index + 1) }));
    const listAuditEvents = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([
        event({
          action: 'task.assigned',
          target: { to: 'Tester' },
          subjectLabel: 'Older task',
          occurredAt: at(24 * 60 + 1)
        })
      ]);
    render(
      <AuthContextOverride value={adminAuthStub()}>
        <HistoryDialog teamId={TEAM} client={{ listAuditEvents }} onClose={vi.fn()} />
      </AuthContextOverride>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByRole('region', { name: 'Yesterday' })).toBeTruthy();
    expect(screen.getByText('Task given to Tester')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Today' })).toBeTruthy();
    expect(listAuditEvents).toHaveBeenLastCalledWith(TEAM, {
      limit: 50,
      before: first.at(-1)!.occurredAt
    });
    expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
  });

  it('shows a failed read as an error rather than an empty history', async () => {
    render(
      <AuthContextOverride value={adminAuthStub()}>
        <HistoryDialog
          teamId={TEAM}
          client={{ listAuditEvents: vi.fn().mockRejectedValue(new Error('offline')) }}
          onClose={vi.fn()}
        />
      </AuthContextOverride>
    );
    expect(await screen.findByText('Could not load this space’s history.')).toBeTruthy();
    expect(screen.queryByText('Nothing has happened here yet.')).toBeNull();
  });

  it('names catalog creation, assignment and failures, and opens a task from its history line', async () => {
    const close = vi.fn();
    render(
      <AuthContextOverride value={adminAuthStub()}>
        <HistoryDialog
          teamId={TEAM}
          onClose={close}
          client={{
            listAuditEvents: vi.fn().mockResolvedValue([
              event({ action: 'material.uploaded', subjectLabel: 'QA_v1_catalog' }),
              event({ action: 'task.assigned', subjectLabel: 'Unassigned task' }),
              event({
                action: 'task.file_attached',
                target: { task_id: 'task-qa' },
                subjectLabel: 'QA attachment'
              }),
              event({ action: 'drive.resynced', subjectLabel: 'Storage', result: 'denied' }),
              event({ action: 'material.uploaded', subjectLabel: 'Failed file', result: 'failed' })
            ])
          }}
        />
      </AuthContextOverride>
    );
    expect(await screen.findByText('Catalog created')).toBeTruthy();
    expect(screen.getByText('Task left unassigned')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'QA attachment' });
    const href = link.getAttribute('href');
    fireEvent.click(link);
    expect(close).toHaveBeenCalledOnce();
    expect(window.location.pathname + window.location.search).toBe(href);
  });
});

describe('the audit settings panel', () => {
  it('keeps failed loading distinct from empty and recovers on refresh', async () => {
    const listAuditEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    const client = { listAuditEvents };
    const view = render(<TeamAuditPanel teamId={TEAM} client={client} />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not load this space’s history.'
    );
    expect(screen.queryByText('Nothing has happened here yet.')).toBeNull();
    view.rerender(<TeamAuditPanel teamId={TEAM} client={client} revision={1} />);
    expect(await screen.findByText('Nothing has happened here yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the subject and distinct denied, canceled and failed outcomes without duplicate state', async () => {
    render(
      <TeamAuditPanel
        teamId={TEAM}
        client={{
          listAuditEvents: vi.fn().mockResolvedValue([
            event({
              action: 'material.rename',
              subjectLabel: 'Denied file',
              result: 'denied',
              target: { state: 'ready' }
            }),
            event({
              action: 'operation.canceled',
              subjectLabel: 'Canceled operation',
              result: 'canceled',
              target: { state: 'canceled' }
            }),
            event({
              action: 'material.upload',
              subjectLabel: 'Failed upload',
              result: 'failed',
              target: { warning_code: 'bounded-warning' },
              errorCode: 'DRIVE_UNAVAILABLE'
            })
          ])
        }}
      />
    );
    expect(await screen.findByTitle('Denied file')).toBeTruthy();
    expect(screen.getByTitle('Canceled operation')).toBeTruthy();
    expect(screen.getByTitle('Failed upload')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getByText('Canceled')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('canceled', { exact: true })).toBeNull();
    expect(screen.getByText('DRIVE_UNAVAILABLE')).toBeTruthy();
  });
});
