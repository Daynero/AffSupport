import { isRecord } from './contract.js';
import { parseTeamAccount, type TeamAccountSummary } from './accounts.js';
export interface TeamAccountLaunchSummary {
  id: string;
  agentRowId: string | null;
  accountId: string | null;
  revisionId: string | null;
  launchDate: string | null;
  workStatus: string;
  hasResult: boolean;
  creativeAlias: string;
  method: string;
  unmatchedReason: 'missing_agent' | 'unknown_agent' | null;
}
export interface TeamAccountsOverview {
  schemaVersion: 1;
  accounts: TeamAccountSummary[];
  socialOrderVersion: string;
  agentOrderVersions: Record<string, string>;
  coverage: 'complete' | 'partial';
  launchSummaries?: TeamAccountLaunchSummary[];
  launchCoverage?: 'complete' | 'partial';
}
export function parseTeamAccountsOverview(value: unknown): TeamAccountsOverview | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.accounts) ||
    typeof value.socialOrderVersion !== 'string' ||
    !/^\d{1,19}$/.test(value.socialOrderVersion) ||
    !isRecord(value.agentOrderVersions) ||
    !Object.values(value.agentOrderVersions).every(
      item => typeof item === 'string' && /^\d{1,19}$/.test(item)
    ) ||
    !['complete', 'partial'].includes(String(value.coverage))
  )
    return null;
  const accounts: TeamAccountSummary[] = [];
  for (const raw of value.accounts) {
    const account = parseTeamAccount(raw);
    if (!account) return null;
    accounts.push(account);
  }
  if (
    value.launchSummaries !== undefined &&
    (!Array.isArray(value.launchSummaries) ||
      !value.launchSummaries.every(isTeamAccountLaunchSummary))
  )
    return null;
  if (
    value.launchCoverage !== undefined &&
    value.launchCoverage !== 'complete' &&
    value.launchCoverage !== 'partial'
  )
    return null;
  return {
    ...(value.launchSummaries !== undefined
      ? { launchSummaries: value.launchSummaries as TeamAccountLaunchSummary[] }
      : {}),
    ...(value.launchCoverage !== undefined
      ? { launchCoverage: value.launchCoverage as 'complete' | 'partial' }
      : {}),
    schemaVersion: 1,
    accounts,
    socialOrderVersion: value.socialOrderVersion,
    agentOrderVersions: value.agentOrderVersions as Record<string, string>,
    coverage: value.coverage as 'complete' | 'partial'
  };
}

function isTeamAccountLaunchSummary(value: unknown): value is TeamAccountLaunchSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.agentRowId === null || typeof value.agentRowId === 'string') &&
    (value.accountId === null || typeof value.accountId === 'string') &&
    (value.revisionId === null || typeof value.revisionId === 'string') &&
    (value.launchDate === null ||
      (typeof value.launchDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.launchDate))) &&
    typeof value.workStatus === 'string' &&
    typeof value.hasResult === 'boolean' &&
    typeof value.creativeAlias === 'string' &&
    typeof value.method === 'string' &&
    (value.unmatchedReason === null ||
      value.unmatchedReason === 'missing_agent' ||
      value.unmatchedReason === 'unknown_agent')
  );
}
