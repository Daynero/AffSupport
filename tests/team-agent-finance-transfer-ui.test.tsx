// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FinanceSnapshot } from '@video-compressor/shared';
import { MoveAgentDialog } from '../apps/web/src/team/accounts/finance/MoveAgentDialog';
afterEach(cleanup);
it('searches targets and explains why a same-day financial entry blocks a move', () => {
  const snapshot: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-10-03',
    to: '2026-10-03',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [
      { id: 'x', name: 'Source' },
      { id: 'y', name: 'Target' },
      { id: 'z', name: 'Other' }
    ],
    agents: [{ id: 'a', agentId: '001234' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'a',
        accountId: 'x',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [
      {
        agentRowId: 'a',
        placementId: 'p',
        date: '2026-10-03',
        metric: 'spend',
        value: null,
        version: '2',
        currency: 'USD',
        updatedAt: 'now',
        updatedBy: null
      }
    ]
  };
  render(
    <MoveAgentDialog
      snapshot={snapshot}
      agent="a"
      today="2026-10-03"
      timezone="UTC"
      onClose={vi.fn()}
      onMoved={vi.fn()}
    />
  );
  expect(screen.getByText(/001234/)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Target' } });
  expect(screen.getByText(/already has financial history today/i)).toBeTruthy();
  expect(
    (
      screen.getByRole('button', {
        name: 'Move to another account'
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
});
