import { expect, it } from 'vitest';
import { parseTeamAccount, parseTeamAccountAgent } from '../packages/shared/src/team/accounts';
import {
  parseFinanceSnapshot,
  type FinanceSnapshot
} from '../packages/shared/src/team/agent-finance';
import {
  buildFinanceReport,
  buildFinanceTopupCopy,
  financeAgentVisible
} from '../packages/shared/src/team/agent-finance-report';

const createdAt = '2026-10-18T22:30:00Z';
function snapshot(): FinanceSnapshot {
  return {
    schemaVersion: 2,
    teamId: 'team',
    teamName: 'Team',
    from: '2026-10-01',
    to: '2026-10-20',
    currency: 'USD',
    generatedAt: createdAt,
    accounts: [{ id: 'social', name: 'Social' }],
    agents: [{ id: 'rk', agentId: 'g1' }],
    placements: [
      {
        id: 'p',
        agentRowId: 'rk',
        accountId: 'social',
        startsOn: '2026-10-01',
        endsOn: null,
        version: '1'
      }
    ],
    fields: [],
    lifecycle: {
      accounts: [
        {
          id: 'social',
          createdAt,
          startsOn: '2026-10-10',
          archivedAt: null,
          version: '0',
          sortRank: '0'
        }
      ],
      agents: [
        {
          id: 'rk',
          accountId: 'social',
          createdAt,
          startsOn: '2026-10-12',
          archivedAt: null,
          version: '0',
          sortRank: '0'
        }
      ],
      events: [],
      parents: []
    }
  };
}
function field(data: FinanceSnapshot, date: string) {
  data.fields.push({
    agentRowId: 'rk',
    date,
    metric: 'topup',
    value: '0.00',
    currency: 'USD',
    version: '1',
    placementId: 'p',
    updatedAt: createdAt,
    updatedBy: null
  });
}
function accountRows(startsOn?: unknown) {
  const metadata = {
    created_at: createdAt,
    updated_at: createdAt,
    ...(startsOn === undefined ? {} : { starts_on: startsOn })
  };
  return {
    account: { id: 'social', team_id: 'team', name: 'Social', agents: [], ...metadata },
    agent: {
      id: 'rk',
      account_id: 'social',
      team_id: 'team',
      agent_id: 'g1',
      runs: [],
      labels: [],
      balance: null,
      topup: null,
      ...metadata
    }
  };
}
it('parses effective dates without rewriting audit creation, allowing omitted legacy birth', () => {
  for (const date of ['2026-10-12', undefined, null]) {
    const rows = accountRows(date);
    expect(parseTeamAccount(rows.account)).toMatchObject({
      createdAt,
      ...(date ? { startsOn: date } : {})
    });
    expect(parseTeamAccountAgent(rows.agent)).toMatchObject({
      createdAt,
      ...(date ? { startsOn: date } : {})
    });
  }
  expect(parseFinanceSnapshot(snapshot())?.lifecycle?.agents[0]).toMatchObject({
    createdAt,
    startsOn: '2026-10-12'
  });
});
it('accepts a nullable legacy composite column while requiring lifecycle keys to be omitted', () => {
  const rows = accountRows(null);
  expect(parseTeamAccount(rows.account)).not.toHaveProperty('startsOn');
  expect(parseTeamAccountAgent(rows.agent)).not.toHaveProperty('startsOn');
  const data = snapshot();
  Object.assign(data.lifecycle!.agents[0]!, { startsOn: null });
  expect(parseFinanceSnapshot(data)).toBeNull();
});
it.each(['2026-02-30', '2026-1-01', '2026-10-12T00:00:00Z', '', 12])(
  'rejects invalid effective date %s across contracts',
  value => {
    const rows = accountRows(value);
    expect(parseTeamAccount(rows.account)).toBeNull();
    expect(parseTeamAccountAgent(rows.agent)).toBeNull();
    for (const kind of ['accounts', 'agents'] as const) {
      const data = snapshot();
      Object.assign(data.lifecycle![kind][0]!, { startsOn: value });
      expect(parseFinanceSnapshot(data)).toBeNull();
    }
  }
);
it('shows backdated creation from its effective day forward independent of audit timezone', () => {
  const data = snapshot();
  for (const timezone of ['UTC', 'Europe/Kyiv', 'America/Los_Angeles']) {
    expect(financeAgentVisible(data, 'rk', '2026-10-11', timezone)).toBe(false);
    expect(financeAgentVisible(data, 'rk', '2026-10-12', timezone)).toBe(true);
    expect(financeAgentVisible(data, 'rk', '2026-10-20', timezone)).toBe(true);
  }
  data.lifecycle!.accounts[0]!.startsOn = '2026-10-14';
  expect(financeAgentVisible(data, 'rk', '2026-10-13')).toBe(false);
  expect(financeAgentVisible(data, 'rk', '2026-10-14')).toBe(true);
});
it('never permits saved zero before explicit birth to leak into reports or copying', () => {
  for (const kind of ['accounts', 'agents'] as const) {
    const data = snapshot();
    data.lifecycle![kind][0]!.startsOn = '2026-10-14';
    field(data, '2026-10-13');
    expect(financeAgentVisible(data, 'rk', '2026-10-13')).toBe(false);
    expect(parseFinanceSnapshot(data)).toBeNull();
    expect(() => buildFinanceReport(data)).toThrow('INVALID_RESPONSE');
    expect(() => buildFinanceTopupCopy(data)).toThrow('INVALID_RESPONSE');
  }
});
it('preserves legacy saved history before audit creation when effective dates are absent', () => {
  const data = snapshot();
  delete data.lifecycle!.accounts[0]!.startsOn;
  delete data.lifecycle!.agents[0]!.startsOn;
  field(data, '2026-10-10');
  expect(parseFinanceSnapshot(data)).not.toBeNull();
  expect(financeAgentVisible(data, 'rk', '2026-10-10')).toBe(true);
  expect(financeAgentVisible(data, 'rk', '2026-10-11')).toBe(false);
  expect(buildFinanceReport(data).totals.topup).toBe('0.00');
});
it('preserves archive/restore gaps and finds a midrange birth with archived endpoints', () => {
  const data = snapshot();
  data.lifecycle!.events = [
    { entityKind: 'agent', entityId: 'rk', archived: true, occurredAt: '2026-10-14T10:00:00Z' },
    { entityKind: 'agent', entityId: 'rk', archived: false, occurredAt: '2026-10-16T10:00:00Z' },
    { entityKind: 'agent', entityId: 'rk', archived: true, occurredAt: '2026-10-17T10:00:00Z' }
  ];
  data.lifecycle!.agents[0]!.archivedAt = '2026-10-17T10:00:00Z';
  expect(financeAgentVisible(data, 'rk', '2026-10-13')).toBe(true);
  expect(financeAgentVisible(data, 'rk', '2026-10-15')).toBe(false);
  expect(financeAgentVisible(data, 'rk', '2026-10-16')).toBe(true);
  expect(financeAgentVisible(data, 'rk', '2026-10-18')).toBe(false);
  expect(buildFinanceReport(data).columns).toHaveLength(1);
  data.from = '2026-10-01';
  data.to = '2026-10-11';
  const report = buildFinanceReport(data);
  expect(report.columns).toEqual([]);
  expect(report.accounts).toEqual([]);
  expect(report.agents).toEqual([]);
});

it('an explicitly backdated child proves an undated legacy parent existed before its audit row', () => {
  const data = snapshot();
  delete data.lifecycle!.accounts[0]!.startsOn;
  expect(financeAgentVisible(data, 'rk', '2026-10-11')).toBe(false);
  expect(financeAgentVisible(data, 'rk', '2026-10-12')).toBe(true);
  expect(financeAgentVisible(data, 'rk', '2026-10-17')).toBe(true);
  data.to = '2026-10-13';
  expect(buildFinanceReport(data).columns).toHaveLength(1);
});
