import { financeMoney } from './agent-finance.js';
import type { FinanceMetric, FinanceSnapshot } from './agent-finance.js';

type Totals = { spend: string | null; topup: string | null };
export interface FinanceColumn {
  accountId: string;
  accountName: string;
  agentRowId: string;
  agentId: string;
  totals: Totals;
}
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function sum(values: readonly (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null);
  return present.length
    ? financeMoney(
        present.reduce((n, v) => {
          // A total can exceed the per-entry input ceiling. Never pass an aggregate
          // back through the bounded input parser or treat an invalid amount as zero.
          if (!/^\d+\.\d{2}$/u.test(v)) throw new Error('INVALID_RESPONSE');
          return n + BigInt(v.replace('.', ''));
        }, 0n)
      )
    : null;
}
export function buildFinanceReport(snapshot: FinanceSnapshot) {
  const pairs = new Map<string, FinanceColumn>();
  for (const p of snapshot.placements) {
    const a = snapshot.accounts.find(a => a.id === p.accountId);
    const agent = snapshot.agents.find(a => a.id === p.agentRowId);
    if (!a || !agent) throw new Error('INVALID_RESPONSE');
    pairs.set(`${a.id}/${agent.id}`, {
      accountId: a.id,
      accountName: a.name,
      agentRowId: agent.id,
      agentId: agent.agentId,
      totals: { spend: null, topup: null }
    });
  }
  const fieldMap = new Map<string, string | null>();
  const dates: string[] = [];
  for (
    let d = new Date(`${snapshot.from}T00:00:00Z`);
    d.toISOString().slice(0, 10) <= snapshot.to;
    d.setUTCDate(d.getUTCDate() + 1)
  )
    dates.push(d.toISOString().slice(0, 10));
  for (const f of snapshot.fields) {
    const p = snapshot.placements.find(p => p.id === f.placementId);
    if (
      !p ||
      p.agentRowId !== f.agentRowId ||
      f.date < p.startsOn ||
      (p.endsOn !== null && f.date >= p.endsOn)
    )
      throw new Error('INVALID_RESPONSE');
    fieldMap.set(`${p.accountId}/${f.agentRowId}/${f.date}/${f.metric}`, f.value);
  }
  const cell = (accountId: string, agent: string, date: string, metric: FinanceMetric) =>
    fieldMap.get(`${accountId}/${agent}/${date}/${metric}`) ?? null;
  const columns = [...pairs.values()].sort(
    (a, b) =>
      natural.compare(a.accountName, b.accountName) ||
      a.accountId.localeCompare(b.accountId) ||
      natural.compare(a.agentId, b.agentId) ||
      a.agentRowId.localeCompare(b.agentRowId)
  );
  for (const c of columns)
    for (const metric of ['spend', 'topup'] as const)
      c.totals[metric] = sum(dates.map(d => cell(c.accountId, c.agentRowId, d, metric)));
  const totals: Totals = {
    spend: sum(columns.map(c => c.totals.spend)),
    topup: sum(columns.map(c => c.totals.topup))
  };
  const agents = snapshot.agents.map(a => ({
    ...a,
    totals: {
      spend: sum(columns.filter(c => c.agentRowId === a.id).map(c => c.totals.spend)),
      topup: sum(columns.filter(c => c.agentRowId === a.id).map(c => c.totals.topup))
    }
  }));
  const accounts = snapshot.accounts.map(a => ({
    ...a,
    totals: {
      spend: sum(columns.filter(c => c.accountId === a.id).map(c => c.totals.spend)),
      topup: sum(columns.filter(c => c.accountId === a.id).map(c => c.totals.topup))
    }
  }));
  const topups = dates.flatMap(date =>
    columns.flatMap(c => {
      const value = cell(c.accountId, c.agentRowId, date, 'topup');
      return value === null ? [] : [{ date, ...c, value }];
    })
  );
  return { dates, columns, cell, totals, agents, accounts, topups };
}

/** Facts only: a copied entry is not a payment instruction and never clears it. */
export function buildFinanceTopupCopy(
  snapshot: FinanceSnapshot,
  grouping: 'account' | 'label' = 'account',
  labels: Readonly<Record<string, readonly string[]>> = {},
  untagged = 'No tags',
  date = snapshot.from
) {
  const rows = buildFinanceReport(snapshot).topups.filter(
    row => row.date === date && row.value !== '0.00'
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const names = [...new Set(labels[row.agentRowId] ?? [])].sort(natural.compare);
    // Combining labels on a single heading avoids copying the same payment
    // more than once when an agent has several tags.
    const key = grouping === 'account' ? row.accountName : names.join(' + ') || untagged;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const total = sum(rows.map(row => row.value));
  const text = rows.length
    ? Array.from(groups)
        .sort(([a], [b]) => natural.compare(a, b))
        .map(([heading, items]) =>
          [
            heading.replace(/№\s*/gu, '#'),
            ...items.map(row => `${row.agentId} - $${row.value.replace(/\.00$/u, '')}`)
          ].join('\n')
        )
        .join('\n\n')
    : '';
  return { text, count: rows.length, total };
}
