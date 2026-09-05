import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  sortTeamAccounts,
  type TeamAccountAgentSummary,
  type TeamAccountSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { getSupabaseClient } from '../../lib/supabase';

/**
 * The client seam for the accounts section: what `AccountSpace` needs of the
 * API and nothing more, so a test can hand it a stub and a preview a fixture.
 */
export interface AccountsClient {
  listAccounts(teamId: string): Promise<TeamAccountSummary[]>;
  createAccount(input: { teamId: string; name: string }): Promise<TeamAccountSummary>;
  renameAccount(input: {
    teamId: string;
    accountId: string;
    name: string;
  }): Promise<Omit<TeamAccountSummary, 'agents'>>;
  deleteAccount(input: { teamId: string; accountId: string }): Promise<true>;
  addAccountAgent(input: {
    teamId: string;
    accountId: string;
    agentId: string;
    note?: string | null;
  }): Promise<TeamAccountAgentSummary>;
  updateAccountAgent(input: {
    teamId: string;
    agentRowId: string;
    agentId: string;
  }): Promise<TeamAccountAgentSummary>;
  deleteAccountAgent(input: { teamId: string; agentRowId: string }): Promise<true>;
  addAgentRun(input: {
    teamId: string;
    agentRowId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary>;
  updateAgentRun(input: {
    teamId: string;
    runId: string;
    note: string;
  }): Promise<TeamAccountAgentSummary>;
  deleteAgentRun(input: { teamId: string; runId: string }): Promise<TeamAccountAgentSummary>;
  clearAgentRuns(input: { teamId: string; agentRowId: string }): Promise<TeamAccountAgentSummary>;
}

const defaultClient: AccountsClient = teamApi;

/**
 * The last list each space showed, kept for the life of the page.
 *
 * The section unmounts on every trip to another tab, so without this every
 * return began with "Loading…" over an empty frame. Now the list is on screen
 * at once and re-read quietly behind it; realtime carries anyone else's
 * changes, so what is shown in the meantime is at most a moment old. Only the
 * production client is cached: a stubbed one is a test's own data.
 */
const cache = new Map<string, TeamAccountSummary[]>();

function replaceAccount(
  accounts: TeamAccountSummary[],
  accountId: string,
  update: (account: TeamAccountSummary) => TeamAccountSummary
): TeamAccountSummary[] {
  return sortTeamAccounts(
    accounts.map(account => (account.id === accountId ? update(account) : account))
  );
}

/**
 * The accounts of a space, kept live.
 *
 * Every mutation applies the row the server returned straight into local state,
 * so the person who made the change sees it at once; the realtime channel is
 * for everyone else, and for the rare case where a write raced a read. The
 * list is small — tens of accounts, a few agents each — so there is no paging
 * and no partial refetch: a change anywhere re-reads the whole list.
 */
export function useAccounts({
  teamId,
  revision = 0,
  client = defaultClient
}: {
  teamId: string;
  revision?: number;
  client?: AccountsClient;
}) {
  const cached = client === defaultClient ? cache.get(teamId) : undefined;
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      const next = await client.listAccounts(teamId);
      if (requestGeneration !== generation.current) return;
      setAccounts(sortTeamAccounts(next));
      setError(null);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [client, teamId]);

  useEffect(() => {
    // A cached list stays on screen while it is re-read; only a space never
    // seen before shows the loading line.
    if (!(client === defaultClient && cache.has(teamId))) setLoading(true);
    void refetch();
    return () => {
      generation.current += 1;
    };
  }, [client, refetch, revision, teamId]);

  useEffect(() => {
    if (client === defaultClient && !loading) cache.set(teamId, accounts);
  }, [accounts, client, loading, teamId]);

  // Live sync, the same way tasks do it: one channel per space, both tables,
  // bursts coalesced. A custom client is a test or preview data source and is
  // never wired to the production channel.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (client !== defaultClient) return;
    const supabase = getSupabaseClient();
    if (!supabase || !teamId) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refetchRef.current();
      }, 300);
    };

    const channel: RealtimeChannel = supabase
      .channel(`team-accounts:${teamId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_accounts', filter: `team_id=eq.${teamId}` },
        scheduleRefetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_account_agents',
          filter: `team_id=eq.${teamId}`
        },
        scheduleRefetch
      )
      // The Tasks column counts tags; a teammate tagging a task, or a task
      // being deleted with its tags, changes it without touching the agent.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_task_agents', filter: `team_id=eq.${teamId}` },
        scheduleRefetch
      )
      .subscribe();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [client, teamId]);

  const createAccount = useCallback(
    async (name: string) => {
      const created = await client.createAccount({ teamId, name });
      setAccounts(current => sortTeamAccounts([...current, created]));
      return created;
    },
    [client, teamId]
  );

  const renameAccount = useCallback(
    async (accountId: string, name: string) => {
      const renamed = await client.renameAccount({ teamId, accountId, name });
      setAccounts(current =>
        replaceAccount(current, accountId, account => ({ ...account, ...renamed }))
      );
      return renamed;
    },
    [client, teamId]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      await client.deleteAccount({ teamId, accountId });
      setAccounts(current => current.filter(account => account.id !== accountId));
    },
    [client, teamId]
  );

  const addAgent = useCallback(
    async (accountId: string, agentId: string, note: string | null) => {
      const created = await client.addAccountAgent({ teamId, accountId, agentId, note });
      setAccounts(current =>
        replaceAccount(current, accountId, account => ({
          ...account,
          agents: [...account.agents.filter(agent => agent.id !== created.id), created]
        }))
      );
      return created;
    },
    [client, teamId]
  );

  /** Replaces one agent in place with what a write returned. */
  const putAgent = useCallback((updated: TeamAccountAgentSummary) => {
    setAccounts(current =>
      replaceAccount(current, updated.accountId, account => ({
        ...account,
        agents: account.agents.map(item => (item.id === updated.id ? updated : item))
      }))
    );
    return updated;
  }, []);

  const updateAgent = useCallback(
    async (agent: TeamAccountAgentSummary, agentId: string) =>
      putAgent(await client.updateAccountAgent({ teamId, agentRowId: agent.id, agentId })),
    [client, putAgent, teamId]
  );

  const addRun = useCallback(
    async (agent: TeamAccountAgentSummary, note: string) =>
      putAgent(await client.addAgentRun({ teamId, agentRowId: agent.id, note })),
    [client, putAgent, teamId]
  );

  const updateRun = useCallback(
    async (runId: string, note: string) =>
      putAgent(await client.updateAgentRun({ teamId, runId, note })),
    [client, putAgent, teamId]
  );

  const deleteRun = useCallback(
    async (runId: string) => putAgent(await client.deleteAgentRun({ teamId, runId })),
    [client, putAgent, teamId]
  );

  /** Frees the agent: every run goes at once. */
  const clearRuns = useCallback(
    async (agent: TeamAccountAgentSummary) =>
      putAgent(await client.clearAgentRuns({ teamId, agentRowId: agent.id })),
    [client, putAgent, teamId]
  );

  const deleteAgent = useCallback(
    async (agent: TeamAccountAgentSummary) => {
      await client.deleteAccountAgent({ teamId, agentRowId: agent.id });
      setAccounts(current =>
        replaceAccount(current, agent.accountId, account => ({
          ...account,
          agents: account.agents.filter(item => item.id !== agent.id)
        }))
      );
    },
    [client, teamId]
  );

  return {
    accounts,
    loading,
    error,
    refetch,
    createAccount,
    renameAccount,
    deleteAccount,
    addAgent,
    updateAgent,
    deleteAgent,
    addRun,
    updateRun,
    deleteRun,
    clearRuns
  };
}
