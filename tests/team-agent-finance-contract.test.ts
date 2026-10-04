import { describe, expect, it } from 'vitest';
import {
  parseFinanceMoney,
  financeMoney,
  validFinanceDate,
  validFinanceTimezone,
  parseFinanceSnapshot,
  parseFinanceMutation,
  isFinanceField,
  financeToday,
  type FinanceSnapshot
} from '../packages/shared/src/team/agent-finance';

describe('daily money boundaries', () => {
  it('keeps missing, explicit zero and cents distinct', () => {
    expect(parseFinanceMoney('')).toBe(null);
    expect(parseFinanceMoney('0')).toBe(0n);
    expect(parseFinanceMoney('125,50')).toBe(12550n);
    expect(financeMoney(12550n)).toBe('125.50');
    expect(parseFinanceMoney('999999999.99')).toBe(99999999999n);
    for (const invalid of ['-1', '1.001', '1e3', '1000000000', 'NaN'])
      expect(parseFinanceMoney(invalid)).toBe(undefined);
  });
  it('validates real calendar dates and timezone names', () => {
    expect(validFinanceDate('2024-02-29')).toBe(true);
    expect(validFinanceDate('2025-02-29')).toBe(false);
    expect(validFinanceDate('2026-13-01')).toBe(false);
    expect(validFinanceTimezone('Asia/Tokyo')).toBe(true);
    expect(validFinanceTimezone('invalid')).toBe(false);
  });
  it('rejects untrusted snapshots', () => {
    for (const value of [null, [], {}, { schemaVersion: 1 }])
      expect(parseFinanceSnapshot(value)).toBe(null);
  });
  it('validates complete DTOs, relationships and canonical amounts', () => {
    const s: FinanceSnapshot = {
      schemaVersion: 1,
      teamId: 't',
      teamName: 'T',
      from: '2026-09-01',
      to: '2026-09-30',
      currency: 'USD',
      generatedAt: '2026-10-03T10:00:00Z',
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
      fields: [
        {
          agentRowId: 'a',
          date: '2026-09-01',
          metric: 'spend',
          value: '0.00',
          currency: 'USD',
          version: '1',
          placementId: 'p',
          updatedAt: '2026-09-01T10:00:00Z',
          updatedBy: null
        }
      ]
    };
    expect(parseFinanceSnapshot(s)).toEqual(s);
    expect(parseFinanceSnapshot({ ...s, from: '2026-08-28', to: '2026-10-12' })).toBeTruthy();
    expect(isFinanceField({ ...s.fields[0], value: '' })).toBe(false);
    expect(isFinanceField({ ...s.fields[0], value: null })).toBe(true);
    for (const change of [
      { accounts: [{}] },
      { agents: [{}] },
      { placements: [{}] },
      { fields: [{}] },
      { from: '2025-08-01' },
      { to: '2026-08-01' },
      { accounts: [s.accounts[0], s.accounts[0]] },
      { placements: [{ ...s.placements[0], accountId: 'missing' }] },
      { placements: [{ ...s.placements[0], endsOn: '2025-01-01' }] },
      { fields: [{ ...s.fields[0], placementId: 'missing' }] },
      { fields: [s.fields[0], s.fields[0]] }
    ])
      expect(parseFinanceSnapshot({ ...s, ...change })).toBe(null);
    const mutation = { requestId: 'r', undoReference: null, fields: s.fields };
    expect(parseFinanceMutation(mutation)).toEqual(mutation);
    expect(parseFinanceMutation({ ...mutation, undoReference: 1 })).toBe(null);
    expect(parseFinanceMutation(null)).toBe(null);
    expect(financeToday('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(parseFinanceMoney(null)).toBe(null);
    expect(parseFinanceMoney(1)).toBe(undefined);
    expect(parseFinanceMoney(' ')).toBe(null);
    expect(financeMoney(10000000000000000n)).toBe('100000000000000.00');
  });
});
