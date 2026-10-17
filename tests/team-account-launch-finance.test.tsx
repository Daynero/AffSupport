// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamAccountOverview } from '@video-compressor/shared';
import { AccountLaunchFinanceTable } from '../apps/web/src/team/accounts/AccountLaunchFinanceTable';

const SOCIAL_A = '17000000-0000-4000-8000-000000000001';
const SOCIAL_B = '17000000-0000-4000-8000-000000000002';
const AGENT = '17000000-0000-4000-8000-000000000003';
const MISSING = '17000000-0000-4000-8000-000000000004';
const placement = (id: string, socialId: string, balanceCents: number | null) => ({
  placementId: id,
  agentRowId: AGENT,
  socialId,
  startsOn: '2026-10-01',
  endsOn: null,
  balanceCents,
  topupCents: 0,
  spendCents: null
});

const overview: TeamAccountOverview = {
  period: { from: '2026-10-01', to: '2026-10-31', currency: 'USD' },
  socials: [
    { id: SOCIAL_A, name: 'Original social', sortRank: 0 },
    { id: SOCIAL_B, name: 'Current social', sortRank: 1 }
  ],
  agents: [{ id: AGENT, socialId: SOCIAL_B, agentId: 'RK-7', sortRank: 0 }],
  launches: [
    {
      id: '17000000-0000-4000-8000-000000000011',
      agentRowId: AGENT,
      snapshotSocialId: SOCIAL_A,
      currentSocialId: SOCIAL_B,
      association: 'moved',
      unmatchedReason: null,
      launchDate: '2026-10-03',
      workStatus: 'done',
      archived: false,
      offer: 'Offer A',
      creativeAlias: 'Creative A'
    },
    {
      id: '17000000-0000-4000-8000-000000000012',
      agentRowId: AGENT,
      snapshotSocialId: SOCIAL_B,
      currentSocialId: SOCIAL_B,
      association: 'matched',
      unmatchedReason: null,
      launchDate: '2026-10-04',
      workStatus: 'todo',
      archived: false,
      offer: 'Offer B',
      creativeAlias: 'Creative B'
    },
    {
      id: '17000000-0000-4000-8000-000000000013',
      agentRowId: MISSING,
      snapshotSocialId: SOCIAL_A,
      currentSocialId: null,
      association: 'unmatched',
      unmatchedReason: 'missing_agent',
      launchDate: '2026-10-05',
      workStatus: 'todo',
      archived: false,
      offer: 'Orphan offer',
      creativeAlias: 'Orphan creative'
    }
  ],
  finance: [
    placement('17000000-0000-4000-8000-000000000021', SOCIAL_A, null),
    placement('17000000-0000-4000-8000-000000000022', SOCIAL_B, 0)
  ]
};

afterEach(() => {
  cleanup();
});

describe('account launch and finance overview', () => {
  it('keeps moved launches and finance under historical socials, with explicit zero and missing values', async () => {
    const client = { getAccountLaunchFinanceOverview: vi.fn(async () => overview) };
    render(<AccountLaunchFinanceTable teamId={SOCIAL_A} revision={0} client={client} />);
    const original = await screen.findByRole('region', { name: 'Original social' });
    const current = screen.getByRole('region', { name: 'Current social' });
    expect(within(original).getByText(/Offer A/).textContent).toContain('Ad account moved');
    expect(within(original).queryByText(/Offer B/)).toBeNull();
    expect(within(original).getAllByText(/No recorded amount/).length).toBeGreaterThan(0);
    expect(within(current).getByText(/Offer B/)).toBeTruthy();
    expect(within(current).getByText(/Balance: 0.00 USD/)).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Unmatched launches' })).getByText(/Orphan offer/)
        .textContent
    ).toContain('Ad account no longer exists');
  });
});
