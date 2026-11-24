import {
  filterTeamAccounts,
  type TeamAccountMarkerFilter,
  type TeamAccountOccupancyFilter,
  type TeamAccountSummary
} from '@video-compressor/shared';

/**
 * What the accounts toolbar asks of the list (070, T047): the shared filter's
 * search, occupancy and colour, plus the two things it does not know about —
 * the agents' tags as words to search for, and one tag to keep.
 */
export interface AccountsViewFilter {
  occupancy: TeamAccountOccupancyFilter;
  search: string;
  marker?: TeamAccountMarkerFilter;
  /** An agent tag's id: only the agents carrying it stay. */
  tag?: string | null;
}

/**
 * The list as the toolbar narrows it.
 *
 * The search is the shared one — every word found, in any order, with the
 * other keyboard layout tried when nothing matches — and it reads an agent's
 * account, id and runs. A tag is how a team names a batch ("#2", "Hot"), so
 * typing it must find the batch: the agent goes into the shared filter with
 * its tags' names after its id, and comes out as itself. Only the search
 * sees that longer id; the order, availability and markers are the agent's
 * own, and the rows drawn are the objects that went in.
 */
export function filterAccountsView(
  accounts: readonly TeamAccountSummary[],
  filter: AccountsViewFilter
): TeamAccountSummary[] {
  const originals = new Map<string, TeamAccountSummary['agents'][number]>();
  const searchable = accounts.map(account => ({
    ...account,
    agents: account.agents.map(agent => {
      originals.set(agent.id, agent);
      return agent.labels.length > 0
        ? {
            ...agent,
            agentId: `${agent.agentId} ${agent.labels.map(label => label.name).join(' ')}`
          }
        : agent;
    })
  }));
  const kept = filterTeamAccounts(searchable, {
    occupancy: filter.occupancy,
    search: filter.search,
    marker: filter.marker
  });
  const byId = new Map(accounts.map(account => [account.id, account]));
  const restored = kept.map(account => ({
    ...byId.get(account.id)!,
    agents: account.agents.map(agent => originals.get(agent.id) ?? agent)
  }));
  const tag = filter.tag;
  if (!tag) return restored;
  return restored.flatMap(account => {
    const agents = account.agents.filter(agent => agent.labels.some(label => label.id === tag));
    return agents.length > 0 ? [{ ...account, agents }] : [];
  });
}

/** Each agent tag on the list, with how many of its agents carry it — the tag menu's counts. */
export function countAgentTags(
  accounts: readonly TeamAccountSummary[]
): Map<string, { name: string; color: string; count: number }> {
  const counts = new Map<string, { name: string; color: string; count: number }>();
  for (const account of accounts) {
    for (const agent of account.agents) {
      for (const label of agent.labels) {
        const entry = counts.get(label.id) ?? { name: label.name, color: label.color, count: 0 };
        entry.count += 1;
        counts.set(label.id, entry);
      }
    }
  }
  return counts;
}
