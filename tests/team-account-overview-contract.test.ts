import { describe, expect, it } from 'vitest';
import { parseTeamAccountOverview } from '../packages/shared/src/team/account-overview.js';

const socialA = 'a0390000-0000-4000-8000-000000000020';
const socialB = 'a0390000-0000-4000-8000-000000000021';
const agent = 'a0390000-0000-4000-8000-000000000030';
const placement = 'a0390000-0000-4000-8000-000000000040';
const launch = 'a0390000-0000-4000-8000-000000000050';

const payload = {
  period: { from: '2026-10-01', to: '2026-10-31', currency: 'USD' },
  socials: [
    { id: socialA, name: 'Social A', sortRank: 1, archivedAt: '2026-10-15T10:00:00Z' },
    { id: socialB, name: 'Social B', sortRank: 2, archivedAt: null }
  ],
  agents: [{ id: agent, socialId: socialB, agentId: 'rk-1', sortRank: 1 }],
  launches: [
    {
      id: launch,
      agentRowId: agent,
      snapshotSocialId: socialA,
      currentSocialId: socialB,
      association: 'moved',
      unmatchedReason: null,
      launchDate: '2026-10-03',
      workStatus: 'done',
      archived: false,
      offer: 'Offer A',
      creativeAlias: ''
    }
  ],
  finance: [
    {
      placementId: placement,
      agentRowId: agent,
      socialId: socialA,
      startsOn: '2026-10-01',
      endsOn: '2026-10-10',
      balanceCents: null,
      topupCents: 0,
      spendCents: null
    }
  ]
};

describe('account overview contract', () => {
  it('keeps historical placement IDs and an explicit zero after a РК moves', () => {
    const parsed = parseTeamAccountOverview(payload);
    expect(parsed?.launches[0]).toMatchObject({
      snapshotSocialId: socialA,
      currentSocialId: socialB,
      association: 'moved'
    });
    expect(parsed?.finance[0]).toMatchObject({
      socialId: socialA,
      topupCents: 0,
      spendCents: null
    });
    expect(parsed?.socials[0].archivedAt).toBe('2026-10-15T10:00:00Z');
  });

  it('rejects an unrecognized match reason or an unsafe money amount', () => {
    expect(
      parseTeamAccountOverview({
        ...payload,
        launches: [{ ...payload.launches[0], association: 'guessed' }]
      })
    ).toBeNull();
    expect(
      parseTeamAccountOverview({
        ...payload,
        finance: [{ ...payload.finance[0], topupCents: Number.MAX_SAFE_INTEGER + 1 }]
      })
    ).toBeNull();
  });
});
