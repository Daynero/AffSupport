import type { FinanceSnapshot, TeamAccountSummary } from '@video-compressor/shared';

/** Inventory is current; only archived rows require saved data in the selected period. */
export function accountsForPeriod(
  accounts: readonly TeamAccountSummary[],
  from: string,
  to: string,
  snapshot: FinanceSnapshot | null,
  hasDraft: (agentId: string) => boolean
): TeamAccountSummary[] {
  const saved = new Set<string>();
  const placements = new Map(snapshot?.placements.map(row => [row.id, row]));
  for (const field of snapshot?.fields ?? []) {
    const placement = placements.get(field.placementId);
    if (
      field.value !== null &&
      field.date >= from &&
      field.date <= to &&
      placement?.agentRowId === field.agentRowId &&
      field.date >= placement.startsOn &&
      (placement.endsOn === null || field.date < placement.endsOn)
    )
      saved.add(`${placement.accountId}/${field.agentRowId}`);
  }
  return accounts.flatMap(social => {
    if (social.startsOn && social.startsOn > to) return [];
    const agents = social.agents.filter(agent => {
      if (agent.startsOn && agent.startsOn > to) return false;
      if (hasDraft(agent.id)) return true;
      return (!social.archivedAt && !agent.archivedAt) || saved.has(`${social.id}/${agent.id}`);
    });
    return !social.archivedAt || agents.length ? [{ ...social, agents }] : [];
  });
}
