import { expect, it } from 'vitest';
import {
  buildFinanceReport,
  financeAgentVisible,
  parseFinanceSnapshot,
  type FinanceSnapshot
} from '@video-compressor/shared';
function snapshot(): FinanceSnapshot {
  return {
    schemaVersion: 2,
    teamId: 'team',
    teamName: 'Team',
    from: '2026-10-17',
    to: '2026-10-18',
    currency: 'USD',
    generatedAt: '2026-10-18T10:00:00Z',
    accounts: [{ id: 'social', name: 'S' }],
    agents: [{ id: 'agent', agentId: 'g1' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'agent',
        accountId: 'social',
        startsOn: '2026-01-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [],
    lifecycle: {
      accounts: [
        {
          id: 'social',
          createdAt: '2026-01-01T00:00:00Z',
          archivedAt: null,
          version: '0',
          sortRank: '0'
        }
      ],
      agents: [
        {
          id: 'agent',
          accountId: 'social',
          createdAt: '2026-01-01T00:00:00Z',
          archivedAt: '2026-10-18T07:00:00Z',
          version: '1',
          sortRank: '0'
        }
      ],
      events: [
        {
          entityKind: 'agent',
          entityId: 'agent',
          archived: true,
          occurredAt: '2026-10-18T07:00:00Z'
        }
      ],
      parents: [
        {
          agentRowId: 'agent',
          accountId: 'social',
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: null,
          provenance: 'migration'
        }
      ]
    }
  };
}
it('parses complete v2 lifecycle and refuses a v2 response missing lifecycle', () => {
  const data = snapshot();
  expect(parseFinanceSnapshot(data)?.schemaVersion).toBe(2);
  expect(parseFinanceSnapshot({ ...data, lifecycle: undefined })).toBeNull();
});
it('keeps yesterday history but hides archived empty today and tomorrow', () => {
  const data = snapshot();
  expect(financeAgentVisible(data, 'agent', '2026-10-17', 'Europe/Kyiv')).toBe(true);
  expect(financeAgentVisible(data, 'agent', '2026-10-18', 'Europe/Kyiv')).toBe(false);
  expect(financeAgentVisible(data, 'agent', '2026-10-19', 'Europe/Kyiv')).toBe(false);
});
it('saved zero retains the archived day and totals, with no carry-forward', () => {
  const data = snapshot();
  data.fields.push({
    agentRowId: 'agent',
    date: '2026-10-18',
    metric: 'spend',
    value: '0.00',
    currency: 'USD',
    version: '1',
    placementId: 'p',
    updatedAt: data.generatedAt,
    updatedBy: null
  });
  expect(financeAgentVisible(data, 'agent', '2026-10-18', 'Europe/Kyiv')).toBe(true);
  expect(financeAgentVisible(data, 'agent', '2026-10-19', 'Europe/Kyiv')).toBe(false);
  expect(buildFinanceReport(data).totals.spend).toBe('0.00');
});
it('a parent archive hides its empty child without modifying child own state', () => {
  const data = snapshot();
  data.lifecycle!.agents[0]!.archivedAt = null;
  data.lifecycle!.accounts[0]!.archivedAt = '2026-10-18T07:00:00Z';
  data.lifecycle!.events = [
    { entityKind: 'social', entityId: 'social', archived: true, occurredAt: '2026-10-18T07:00:00Z' }
  ];
  expect(financeAgentVisible(data, 'agent', '2026-10-17')).toBe(true);
  expect(financeAgentVisible(data, 'agent', '2026-10-18')).toBe(false);
});

it('retains closed history for deleted legacy identities without blocking all finance; live or malformed references still fail', () => {
  const data = snapshot();
  const old: NonNullable<FinanceSnapshot['lifecycle']>['parents'][number] = {
    agentRowId: 'deleted-agent',
    accountId: 'deleted-social',
    startsAt: '2025-01-01T00:00:00Z',
    endsAt: '2025-02-01T00:00:00Z',
    provenance: 'observed'
  };
  data.lifecycle!.parents.unshift(old);
  const parsed = parseFinanceSnapshot(data);
  expect(parsed).not.toBeNull();
  expect(parsed!.lifecycle!.parents[0]).toEqual(old);
  expect(financeAgentVisible(parsed!, 'agent', '2026-10-17', 'UTC')).toBe(true);
  old.endsAt = null;
  expect(parseFinanceSnapshot(data)).toBeNull();
  old.endsAt = '2024-12-31T00:00:00Z';
  expect(parseFinanceSnapshot(data)).toBeNull();
});
