// @vitest-environment jsdom
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FinanceHistoryDrawer } from '../apps/web/src/team/accounts/finance/FinanceHistoryDrawer';
vi.mock('../apps/web/src/api/team-finance', () => ({
  teamFinanceApi: {
    legacy: vi.fn(async () => []),
    history: vi.fn(async () => ({
      events: [
        {
          id: 'e',
          metric: 'spend',
          entry_date: '2026-10-04',
          account_name: 'g1',
          oldValue: '125.50',
          newValue: '150.25',
          actor_name: 'Beta Tester',
          occurred_at: '2026-10-03T22:11:09.442701+00:00'
        }
      ],
      transfers: [],
      nextCursor: null
    }))
  }
}));
afterEach(cleanup);
it('separates history details and formats the edit timestamp in Kyiv time', async () => {
  render(
    <FinanceHistoryDrawer
      teamId="t"
      agent="a"
      accountName="g1"
      agentId="001234"
      onClose={vi.fn()}
    />
  );
  await screen.findByText('150.25');
  expect(screen.getByRole('listitem').textContent).toContain('Beta Tester');
  expect(screen.getByText('125.50').className).toContain('text-ink-muted');
  const timestamps = [...document.querySelectorAll('time')];
  expect(timestamps).toHaveLength(2);
  expect(screen.getByRole('listitem').textContent).toContain('g1 · 04/10/2026');
  expect(timestamps[0].textContent).toContain('01:11:09');
  expect(screen.getByRole('listitem').children).toHaveLength(3);
  expect(screen.getByRole('heading').textContent).toContain('History');
  expect(screen.getByLabelText('g1-234')).toBeTruthy();
  expect(screen.queryByText(/442701/)).toBeNull();
});
