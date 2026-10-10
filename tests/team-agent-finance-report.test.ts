import { expect, it } from 'vitest';
import {
  buildFinanceReport,
  buildFinanceTopupCopy
} from '../packages/shared/src/team/agent-finance-report';
import type { FinanceSnapshot } from '../packages/shared/src/team/agent-finance';
it('merges repeated placements, retains null/zero and never sums daily balances', () => {
  const s: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'Team',
    from: '2026-09-01',
    to: '2026-09-30',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' }
    ],
    agents: [{ id: 'a', agentId: '00123' }],
    placements: [
      {
        id: 'p1',
        accountId: 'x',
        agentRowId: 'a',
        startsOn: '2026-01-01',
        endsOn: '2026-09-15',
        version: '2'
      },
      {
        id: 'p2',
        accountId: 'y',
        agentRowId: 'a',
        startsOn: '2026-09-15',
        endsOn: '2026-09-20',
        version: '2'
      },
      {
        id: 'p3',
        accountId: 'x',
        agentRowId: 'a',
        startsOn: '2026-09-20',
        endsOn: null,
        version: '1'
      }
    ],
    fields: []
  };
  for (const [date, placementId, value] of [
    ['2026-09-10', 'p1', '100.10'],
    ['2026-09-16', 'p2', '40.20'],
    ['2026-09-21', 'p3', '0.00']
  ])
    s.fields.push({
      agentRowId: 'a',
      date: date!,
      placementId: placementId!,
      value: value!,
      metric: 'spend',
      currency: 'USD',
      version: '1',
      updatedAt: 'now',
      updatedBy: null
    });
  const r = buildFinanceReport(s);
  expect(r.columns).toHaveLength(2);
  expect(r.dates).toHaveLength(30);
  expect(r.totals.spend).toBe('140.30');
  expect(r.totals.topup).toBe(null);
  expect(r.columns[0]!.totals.spend).toBe('100.10');
  expect(r.cell('x', 'a', '2026-09-21', 'spend')).toBe('0.00');
  expect(r.cell('x', 'a', '2026-09-22', 'balance')).toBe(null);
});

it('enumerates complete Gregorian months and keeps empty totals empty', () => {
  for (const [from, to, count] of [
    ['2026-12-01', '2026-12-31', 31],
    ['2027-01-01', '2027-01-31', 31],
    ['2024-02-01', '2024-02-29', 29],
    ['2025-02-01', '2025-02-28', 28]
  ] as const) {
    const s: FinanceSnapshot = {
      schemaVersion: 1,
      teamId: 't',
      teamName: 'T',
      from,
      to,
      currency: 'USD',
      generatedAt: 'now',
      accounts: [],
      agents: [],
      placements: [],
      fields: []
    };
    const report = buildFinanceReport(s);
    expect(report.dates).toHaveLength(count);
    expect(report.dates[0]).toBe(from);
    expect(report.dates.at(-1)).toBe(to);
    expect(report.totals).toEqual({ spend: null, topup: null });
  }
});
it('adds huge totals exactly, keeps metrics independent and rejects invalid placement links', () => {
  const s: FinanceSnapshot = {
    schemaVersion: 1,
    teamId: 't',
    teamName: 'T',
    from: '2026-09-01',
    to: '2026-09-30',
    currency: 'USD',
    generatedAt: 'now',
    accounts: [{ id: 'x', name: 'X' }],
    agents: [{ id: 'a', agentId: '001' }],
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
    fields: []
  };
  for (let day = 1; day <= 30; day++)
    s.fields.push({
      agentRowId: 'a',
      date: `2026-09-${String(day).padStart(2, '0')}`,
      metric: 'spend',
      value: '999999999.99',
      currency: 'USD',
      version: '1',
      placementId: 'p',
      updatedAt: 'now',
      updatedBy: null
    });
  s.fields.push(
    { ...s.fields[0]!, metric: 'topup', value: '0.00' },
    { ...s.fields[0]!, metric: 'balance', value: '70.00' }
  );
  const report = buildFinanceReport(s);
  expect(report.totals).toEqual({ spend: '29999999999.70', topup: '0.00' });
  expect(report.topups).toHaveLength(1);
  expect(buildFinanceTopupCopy(s)).toEqual({ text: '', count: 0, total: null });
  const paid = { ...s, fields: s.fields.filter(f => f.metric !== 'topup') };
  paid.fields.push({ ...s.fields[0]!, metric: 'topup', value: '100.25' });
  const copied = buildFinanceTopupCopy(paid, 'label', { a: ['Urgent', 'Partner', 'Urgent'] });
  expect(copied.count).toBe(1);
  expect(copied.total).toBe('100.25');
  expect(copied.text).toContain('Partner + Urgent');
  expect(copied.text).toBe('2026-09-01 · USD\n\nPartner + Urgent\n001 - $100.25');
  expect(copied.text).not.toContain('70.00');
  expect(buildFinanceTopupCopy(paid).text).toBe('2026-09-01 · USD\n\nX\n001 - $100.25');
  paid.fields.push({ ...s.fields[0]!, date: '2026-09-04', metric: 'topup', value: '130.00' });
  expect(buildFinanceTopupCopy(paid, 'label', { a: ['№2'] }, 'Без тега', '2026-09-04')).toEqual({
    text: '2026-09-04 · USD\n\n#2\n001 - $130',
    count: 1,
    total: '130.00'
  });
  expect(buildFinanceTopupCopy(paid, 'label', {}, 'Без тега', '2026-09-05').count).toBe(0);
  expect(buildFinanceTopupCopy(paid, 'label', {}, 'Без тега', '2026-09-04').text).toBe(
    '2026-09-04 · USD\n\nБез тега\n001 - $130'
  );
  expect(() => buildFinanceReport({ ...s, accounts: [] })).toThrow('INVALID_RESPONSE');
  expect(() =>
    buildFinanceReport({ ...s, fields: [{ ...s.fields[0]!, placementId: 'missing' }] })
  ).toThrow('INVALID_RESPONSE');
});
