import { isRecord } from './contract.js';

/** A read-only account-first view. Identity always comes from UUIDs, never labels. */
export interface TeamAccountOverview {
  period: { from: string; to: string; currency: 'USD' };
  socials: { id: string; name: string; sortRank: number; archivedAt: string | null }[];
  agents: { id: string; socialId: string; agentId: string; sortRank: number }[];
  launches: {
    id: string;
    agentRowId: string | null;
    snapshotSocialId: string | null;
    currentSocialId: string | null;
    association: 'matched' | 'moved' | 'unmatched';
    unmatchedReason: 'missing_agent' | 'missing_snapshot_social' | null;
    launchDate: string | null;
    workStatus: 'todo' | 'in_progress' | 'done';
    archived: boolean;
    offer: string;
    creativeAlias: string;
  }[];
  finance: {
    placementId: string;
    agentRowId: string;
    socialId: string;
    startsOn: string;
    endsOn: string | null;
    /** Null means no recorded figure; zero means an explicit recorded zero. */
    balanceCents: number | null;
    topupCents: number | null;
    spendCents: number | null;
  }[];
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}

function optionalIdentifier(value: unknown): value is string | null {
  return value === null || identifier(value);
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function amount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

export function parseTeamAccountOverview(value: unknown): TeamAccountOverview | null {
  if (
    !isRecord(value) ||
    !isRecord(value.period) ||
    !Array.isArray(value.socials) ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.launches) ||
    !Array.isArray(value.finance)
  )
    return null;
  const { period } = value;
  if (
    !date(period.from) ||
    !date(period.to) ||
    period.from > period.to ||
    period.currency !== 'USD'
  )
    return null;
  const socials: TeamAccountOverview['socials'] = [];
  for (const row of value.socials) {
    if (
      !isRecord(row) ||
      !identifier(row.id) ||
      typeof row.name !== 'string' ||
      typeof row.sortRank !== 'number' ||
      !Number.isSafeInteger(row.sortRank) ||
      (row.archivedAt !== null &&
        (typeof row.archivedAt !== 'string' || !Number.isFinite(Date.parse(row.archivedAt))))
    )
      return null;
    socials.push({
      id: row.id,
      name: row.name,
      sortRank: row.sortRank,
      archivedAt: row.archivedAt
    });
  }
  const agents: TeamAccountOverview['agents'] = [];
  for (const row of value.agents) {
    if (
      !isRecord(row) ||
      !identifier(row.id) ||
      !identifier(row.socialId) ||
      typeof row.agentId !== 'string' ||
      typeof row.sortRank !== 'number' ||
      !Number.isSafeInteger(row.sortRank)
    )
      return null;
    agents.push({
      id: row.id,
      socialId: row.socialId,
      agentId: row.agentId,
      sortRank: row.sortRank
    });
  }
  const launches: TeamAccountOverview['launches'] = [];
  for (const row of value.launches) {
    if (
      !isRecord(row) ||
      !identifier(row.id) ||
      !optionalIdentifier(row.agentRowId) ||
      !optionalIdentifier(row.snapshotSocialId) ||
      !optionalIdentifier(row.currentSocialId) ||
      (row.association !== 'matched' &&
        row.association !== 'moved' &&
        row.association !== 'unmatched') ||
      (row.unmatchedReason !== null &&
        row.unmatchedReason !== 'missing_agent' &&
        row.unmatchedReason !== 'missing_snapshot_social') ||
      (row.launchDate !== null && !date(row.launchDate)) ||
      (row.workStatus !== 'todo' &&
        row.workStatus !== 'in_progress' &&
        row.workStatus !== 'done') ||
      typeof row.archived !== 'boolean' ||
      typeof row.offer !== 'string' ||
      typeof row.creativeAlias !== 'string'
    )
      return null;
    launches.push(row as unknown as TeamAccountOverview['launches'][number]);
  }
  const finance: TeamAccountOverview['finance'] = [];
  for (const row of value.finance) {
    if (
      !isRecord(row) ||
      !identifier(row.placementId) ||
      !identifier(row.agentRowId) ||
      !identifier(row.socialId) ||
      !date(row.startsOn) ||
      (row.endsOn !== null && !date(row.endsOn)) ||
      !amount(row.balanceCents) ||
      !amount(row.topupCents) ||
      !amount(row.spendCents)
    )
      return null;
    finance.push(row as unknown as TeamAccountOverview['finance'][number]);
  }
  return {
    period: { from: period.from, to: period.to, currency: 'USD' },
    socials,
    agents,
    launches,
    finance
  };
}
