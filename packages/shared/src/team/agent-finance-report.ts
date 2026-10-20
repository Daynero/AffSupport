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
  const timezone = snapshot.timezone ?? 'UTC';
  const lifecycleCandidates = snapshot.lifecycle
    ? [
        snapshot.from,
        snapshot.to,
        ...snapshot.lifecycle.events
          .filter(event => !event.archived)
          .map(event => financeDay(event.occurredAt, timezone)),
        ...[...snapshot.lifecycle.agents, ...snapshot.lifecycle.accounts].map(
          entity => entity.startsOn ?? financeDay(entity.createdAt, timezone)
        )
      ].filter(date => date >= snapshot.from && date <= snapshot.to)
    : [];

  for (const p of snapshot.placements) {
    if (p.startsOn > snapshot.to || (p.endsOn !== null && p.endsOn <= snapshot.from)) continue;
    if (
      snapshot.lifecycle &&
      !snapshot.fields.some(f => f.placementId === p.id && f.value !== null) &&
      !lifecycleCandidates.some(date =>
        financeAgentVisible(snapshot, p.agentRowId, date, timezone, p.accountId)
      )
    )
      continue;
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
      beforeExplicitBirth(snapshot, f.agentRowId, p.accountId, f.date) ||
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
  const agents = snapshot.agents
    .filter(a => !snapshot.lifecycle || columns.some(c => c.agentRowId === a.id))
    .map(a => ({
      ...a,
      totals: {
        spend: sum(columns.filter(c => c.agentRowId === a.id).map(c => c.totals.spend)),
        topup: sum(columns.filter(c => c.agentRowId === a.id).map(c => c.totals.topup))
      }
    }));
  const accounts = snapshot.accounts
    .filter(a => !snapshot.lifecycle || columns.some(c => c.accountId === a.id))
    .map(a => ({
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

/**
 * The top-ups actually made on one day, copied out (FR-031). Facts only: a
 * copied entry is not a payment instruction and copying never clears it.
 *
 * Two readings of the same set — under the social account the agent sat in
 * on that day (historical, so a later move does not regroup an old day), or
 * under its agent tags. The text opens with the day and the currency, so a
 * pasted list can never be mistaken for another day's; empty and zero
 * top-ups are not money moved and are left out, and `count`/`total` describe
 * exactly the rows in the text.
 */
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
    ? [
        `${date} · ${snapshot.currency}`,
        ...Array.from(groups)
          // Agents without a tag still have money moved; their group is listed
          // last rather than wherever its heading happens to sort.
          .sort(
            ([a], [b]) =>
              Number(grouping === 'label' && a === untagged) -
                Number(grouping === 'label' && b === untagged) || natural.compare(a, b)
          )
          .map(([heading, items]) =>
            [
              heading.replace(/№\s*/gu, '#'),
              ...items.map(row => `${row.agentId} - $${row.value.replace(/\.00$/u, '')}`)
            ].join('\n')
          )
      ].join('\n\n')
    : '';
  return { text, count: rows.length, total };
}

/** A same-day saved zero is still data. Yesterday's amount never retains today. */
export function financeAgentVisible(
  snapshot: FinanceSnapshot,
  agent: string,
  date: string,
  timezone = 'UTC',
  accountId?: string
): boolean {
  const placement = snapshot.placements.find(
    p =>
      p.agentRowId === agent &&
      (!accountId || p.accountId === accountId) &&
      p.startsOn <= date &&
      (p.endsOn === null || date < p.endsOn)
  );
  if (!placement || beforeExplicitBirth(snapshot, agent, placement.accountId, date)) return false;
  if (
    snapshot.fields.some(
      f =>
        f.agentRowId === agent &&
        f.date === date &&
        f.value !== null &&
        f.placementId === placement.id
    )
  )
    return true;
  if (!snapshot.lifecycle) return true;
  const day = (time: string) => financeDay(time, timezone);
  const row = snapshot.lifecycle.agents.find(a => a.id === agent);
  const parent = snapshot.lifecycle.accounts.find(a => a.id === placement.accountId);
  if (
    !row ||
    !parent ||
    (row.startsOn ?? day(row.createdAt)) > date ||
    // An explicitly backdated child proves its legacy parent existed that day.
    (parent.startsOn ?? (row.startsOn ? row.startsOn : day(parent.createdAt))) > date
  )
    return false;
  const active = (kind: 'social' | 'agent', entity: typeof parent) => {
    const events = snapshot
      .lifecycle!.events.filter(
        e => e.entityKind === kind && e.entityId === entity.id && day(e.occurredAt) <= date
      )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (events.length) return !events[events.length - 1]!.archived;
    return !entity.archivedAt || day(entity.archivedAt) > date;
  };
  return active('agent', row) && active('social', parent);
}

/** Explicit effective dates are authoritative; legacy saved history predates audit rows. */
function beforeExplicitBirth(
  snapshot: FinanceSnapshot,
  agentId: string,
  accountId: string,
  date: string
): boolean {
  const agent = snapshot.lifecycle?.agents.find(row => row.id === agentId);
  const account = snapshot.lifecycle?.accounts.find(row => row.id === accountId);
  return (
    (agent?.startsOn !== undefined && date < agent.startsOn) ||
    (account?.startsOn !== undefined && date < account.startsOn)
  );
}

const financeDateFormatters = new Map<string, Intl.DateTimeFormat>();
function financeDay(time: string, timezone: string): string {
  let formatter = financeDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    if (financeDateFormatters.size >= 32) financeDateFormatters.clear();
    financeDateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(time));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
