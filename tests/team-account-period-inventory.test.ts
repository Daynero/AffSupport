import { expect, it } from 'vitest';
import type { FinanceSnapshot, TeamAccountSummary } from '@video-compressor/shared';
import { accountsForPeriod } from '../apps/web/src/team/accounts/accountsForPeriod';

const accounts: TeamAccountSummary[] = [
  {
    id: 'social',
    teamId: 'team',
    name: 'g4',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    agents: [
      {
        id: 'agent',
        teamId: 'team',
        accountId: 'social',
        agentId: '123',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        runs: [],
        labels: [],
        balance: null,
        topup: null,
        taskCount: 0
      }
    ]
  }
];
const archive = '2026-10-18T07:00:00Z';
function fixture() {
  return structuredClone(accounts);
}
function snapshot(value: string | null, date = '2026-10-17'): FinanceSnapshot {
  return {
    schemaVersion: 1,
    teamId: 'team',
    teamName: 'Team',
    from: date,
    to: date,
    currency: 'USD',
    generatedAt: archive,
    accounts: [{ id: 'social', name: 'g4' }],
    agents: [{ id: 'agent', agentId: '123' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'agent',
        accountId: 'social',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '0'
      }
    ],
    fields: [
      {
        agentRowId: 'agent',
        placementId: 'p',
        date,
        metric: 'spend',
        value,
        currency: 'USD',
        version: '0',
        updatedAt: archive,
        updatedBy: null
      }
    ]
  };
}
function project(
  rows: TeamAccountSummary[],
  data: FinanceSnapshot | null = null,
  from = '2026-10-17',
  to = from
) {
  return accountsForPeriod(rows, from, to, data, () => false);
}
it('keeps g4 available with no RK, and when every RK is archived without period data', () => {
  const rows = fixture();
  rows[0]!.agents = [];
  expect(project(rows)).toEqual(rows);
  rows[0]!.agents = fixture()[0]!.agents;
  rows[0]!.agents[0]!.archivedAt = archive;
  expect(project(rows)).toEqual([{ ...rows[0], agents: [] }]);
});
it('keeps active inventory without finance history for days, ranges and unavailable snapshots', () => {
  expect(project(fixture())).toEqual(accounts);
  expect(project(fixture(), snapshot(null), '2026-10-01', '2026-10-31')).toEqual(accounts);
});
it.each(['social', 'agent'] as const)(
  'requires period data for an archived %s, including days before archive',
  kind => {
    const rows = fixture();
    if (kind === 'social') rows[0]!.archivedAt = archive;
    else rows[0]!.agents[0]!.archivedAt = archive;
    const expected = kind === 'social' ? [] : [{ ...rows[0], agents: [] }];
    expect(project(rows)).toEqual(expected);
    expect(project(rows, snapshot(null))).toEqual(expected);
    expect(project(rows, snapshot('0.00'))).toEqual(rows);
    expect(project(rows, snapshot('9.00'), '2026-10-18')).toEqual(expected);
    expect(project(rows, snapshot('9.00'), '2026-10-01', '2026-10-31')).toEqual(rows);
    // Explicit later corrections remain visible; archive must never hide saved money.
    expect(project(rows, snapshot('9.00', '2026-10-19'), '2026-10-19')).toEqual(rows);
  }
);
it('respects effective births and never attributes another social placement to an archived row', () => {
  const rows = fixture();
  rows[0]!.startsOn = '2026-10-18';
  expect(project(rows)).toEqual([]);
  rows[0]!.startsOn = '2026-01-01';
  rows[0]!.agents[0]!.startsOn = '2026-10-18';
  expect(project(rows)).toEqual([{ ...rows[0], agents: [] }]);
  delete rows[0]!.agents[0]!.startsOn;
  rows[0]!.archivedAt = archive;
  const data = snapshot('1.00');
  data.placements[0]!.accountId = 'other';
  expect(project(rows, data)).toEqual([]);
});
it('retains drafts until editing settles, without treating them as saved statistics', () => {
  const rows = fixture();
  rows[0]!.archivedAt = archive;
  expect(accountsForPeriod(rows, '2026-10-17', '2026-10-17', null, () => true)).toEqual(rows);
  expect(project(rows)).toEqual([]);
});
