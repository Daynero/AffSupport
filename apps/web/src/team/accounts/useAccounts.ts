import { accountFlowId, emitAccountSignal, type AccountSignal } from './analytics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sortTeamAccounts,
  financeToday,
  type TeamAccountAgentSummary,
  type TeamAccountSummary,
  type TeamAccountLaunchSummary,
  type TeamAgentRunMarker,
  type TeamAgentRunMarkerSnapshot
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { accountsWorkspaceApi } from '../../api/team-accounts-workspace';

/**
 * The client seam for the accounts section: what `AccountSpace` needs of the
 * API and nothing more, so a test can hand it a stub and a preview a fixture.
 */
export interface AccountsClient {
  listAccounts(teamId: string): Promise<TeamAccountSummary[]>;
  createAccount(input: {
    teamId: string;
    name: string;
    startsOn?: string;
    timezone?: string;
  }): Promise<TeamAccountSummary>;
  renameAccount(input: {
    teamId: string;
    accountId: string;
    name: string;
  }): Promise<Omit<TeamAccountSummary, 'agents'>>;
  setAccountTwoFactor(input: {
    teamId: string;
    accountId: string;
    seed: string | null;
  }): Promise<void>;
  deleteAccount(input: { teamId: string; accountId: string }): Promise<true>;
  addAccountAgent(input: {
    teamId: string;
    accountId: string;
    agentId: string;
    note?: string | null;
    timezone?: string;
    startsOn?: string;
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
  setAgentRunMarker(input: {
    teamId: string;
    runId: string;
    marker: TeamAgentRunMarker | null;
  }): Promise<TeamAccountAgentSummary>;
  clearAgentRunMarkers(input: { teamId: string }): Promise<TeamAgentRunMarkerSnapshot[]>;
  clearAgentRuns(input: { teamId: string; agentRowId: string }): Promise<TeamAccountAgentSummary>;
  attachAgentLabel(input: {
    teamId: string;
    agentRowId: string;
    labelId: string;
  }): Promise<TeamAccountAgentSummary>;
  detachAgentLabel(input: {
    teamId: string;
    agentRowId: string;
    labelId: string;
  }): Promise<TeamAccountAgentSummary>;
}

const defaultClient: AccountsClient = teamApi;

function creationDay(
  startsOn: string | undefined,
  timezone: string | undefined
): AccountSignal['day'] {
  if (!startsOn) return undefined;
  const today = financeToday(timezone);
  const previous = new Date(`${today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return startsOn === today
    ? 'today'
    : startsOn === previous.toISOString().slice(0, 10)
      ? 'previous'
      : 'historical';
}

// Account state belongs to the mounted auth/team scope; no cross-user module cache.

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
  client = defaultClient,
  from,
  to,
  timezone
}: {
  teamId: string;
  revision?: number;
  client?: AccountsClient;
  from?: string;
  to?: string;
  timezone?: string;
}) {
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [launchSummaries, setLaunchSummaries] = useState<TeamAccountLaunchSummary[]>([]);
  const [launchCoverage, setLaunchCoverage] = useState<'complete' | 'partial'>('complete');
  const [orderVersions, setOrderVersions] = useState({
    socials: '0',
    agents: {} as Record<string, string>
  });
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  /**
   * How many writes this space has taken from here.
   *
   * Every write also fires a realtime event, which schedules a re-read — and a
   * re-read that *started* before a later write answers with the row as it was
   * before it. Applying that answer puts the old figure back on screen a second
   * after someone typed the new one, and the only tell is that it eventually
   * corrects itself. So a read that spans a write is dropped: the write already
   * applied the row the server returned, and the next event brings a fresh
   * read anyway.
   *
   * A counter rather than a clock: a write and a read can land in the same
   * millisecond, and `Date.now()` cannot tell which came first.
   */
  const writes = useRef(0);
  const overviewApplied = useRef<string[]>([]);
  const appliedSignals = useRef<
    {
      flowId: string;
      operation: Exclude<keyof AccountsClient, 'listAccounts'>;
      day?: AccountSignal['day'];
    }[]
  >([]);
  const retained = useCallback(
    async <T>(
      operation: Exclude<keyof AccountsClient, 'listAccounts'>,
      execute: () => Promise<T>,
      day?: AccountSignal['day']
    ): Promise<T> => {
      const flowId = accountFlowId();
      const context = day ? { day } : {};
      emitAccountSignal('retained_action', 'requested', { flowId, operation, ...context });
      try {
        const result = await execute();
        emitAccountSignal('retained_action', 'accepted', {
          flowId,
          operation,
          outcome: 'success',
          ...context
        });
        appliedSignals.current.push({ flowId, operation, ...context });
        return result;
      } catch (error) {
        const code =
          error !== null && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
        emitAccountSignal('retained_action', 'terminal', {
          flowId,
          operation,
          ...context,
          code,
          outcome: 'failure',
          result: 'failed'
        });
        throw error;
      }
    },
    []
  );
  useEffect(() => {
    // This effect runs after canonical local account state reaches React's commit.
    // This hook can prove accounts only; finance and launch rendering belong to
    // the composition owner and must never be inferred from an account read.
    for (const flowId of overviewApplied.current.splice(0)) {
      emitAccountSignal('overview', 'applied', {
        flowId,
        outcome: 'success',
        result: 'partial',
        coverage: 'accounts_only'
      });
    }
    for (const { flowId, operation, day } of appliedSignals.current.splice(0)) {
      emitAccountSignal('retained_action', 'applied', {
        flowId,
        operation,
        ...(day ? { day } : {}),
        outcome: 'success',
        result: 'complete'
      });
    }
  }, [accounts]);

  const refetch = useCallback(async (): Promise<TeamAccountSummary[] | null> => {
    const flowId = accountFlowId();
    emitAccountSignal('overview', 'requested', { flowId, coverage: 'accounts_only' });
    const requestGeneration = ++generation.current;
    const writesBefore = writes.current;
    try {
      const overview =
        client === defaultClient && from && to && timezone
          ? await accountsWorkspaceApi.overview(teamId, from, to, timezone)
          : null;
      const next = overview?.accounts ?? (await client.listAccounts(teamId));
      if (requestGeneration !== generation.current || writes.current !== writesBefore) {
        emitAccountSignal('overview', 'terminal', {
          flowId,
          result: 'cancelled',
          outcome: 'cancelled',
          coverage: 'accounts_only'
        });
        return null;
      }
      const canonical = sortTeamAccounts(next);
      emitAccountSignal('overview', 'accepted', {
        flowId,
        result: 'partial',
        outcome: 'success',
        coverage: 'accounts_only',
        count: canonical.length
      });
      overviewApplied.current.push(flowId);
      setAccounts(canonical);
      if (overview) {
        setLaunchSummaries(overview.launchSummaries ?? []);
        setLaunchCoverage(overview.launchCoverage ?? 'partial');
      }
      if (overview)
        setOrderVersions({
          socials: overview.socialOrderVersion,
          agents: overview.agentOrderVersions
        });
      setError(null);
      return canonical;
    } catch (cause) {
      emitAccountSignal('overview', 'terminal', {
        flowId,
        result: 'failed',
        outcome: 'failure',
        code:
          cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : 'UNKNOWN',
        coverage: 'accounts_only'
      });
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      }
      return null;
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [client, teamId, from, to, timezone]);

  useEffect(() => {
    // A cached list stays on screen while it is re-read; only a space never
    // seen before shows the loading line.
    setLoading(true);
    void refetch();
    return () => {
      generation.current += 1;
    };
  }, [client, refetch, revision, teamId]);

  // TeamContext owns the only workspace realtime channel. A local mutation
  // still applies its canonical response immediately; revision refreshes peers.
  const createAccount = useCallback(
    async (name: string, startsOn?: string) => {
      const created = await retained(
        'createAccount',
        () => client.createAccount({ teamId, name, ...(startsOn ? { startsOn, timezone } : {}) }),
        creationDay(startsOn, timezone)
      );
      writes.current += 1;
      setAccounts(current => sortTeamAccounts([...current, created]));
      return created;
    },
    [client, retained, teamId, timezone]
  );

  const renameAccount = useCallback(
    async (accountId: string, name: string) => {
      const renamed = await retained('renameAccount', () =>
        client.renameAccount({ teamId, accountId, name })
      );
      writes.current += 1;
      setAccounts(current =>
        replaceAccount(current, accountId, account => ({ ...account, ...renamed }))
      );
      return renamed;
    },
    [client, retained, teamId]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      await retained('deleteAccount', () => client.deleteAccount({ teamId, accountId }));
      writes.current += 1;
      setAccounts(current => current.filter(account => account.id !== accountId));
    },
    [client, retained, teamId]
  );

  const setAccountTwoFactor = useCallback(
    async (accountId: string, seed: string | null) => {
      await retained('setAccountTwoFactor', () =>
        client.setAccountTwoFactor({ teamId, accountId, seed })
      );
      writes.current += 1;
      setAccounts(current =>
        replaceAccount(current, accountId, account => ({
          ...account,
          twoFactorSeed: seed
        }))
      );
    },
    [client, retained, teamId]
  );

  const addAgent = useCallback(
    async (
      accountId: string,
      agentId: string,
      note: string | null,
      timezone?: string,
      startsOn?: string
    ) => {
      const created = await retained(
        'addAccountAgent',
        () =>
          client.addAccountAgent({
            teamId,
            accountId,
            agentId,
            note,
            timezone,
            ...(startsOn ? { startsOn } : {})
          }),
        creationDay(startsOn, timezone)
      );
      writes.current += 1;
      setAccounts(current =>
        replaceAccount(current, accountId, account => ({
          ...account,
          ...(account.startsOn && created.startsOn && created.startsOn < account.startsOn
            ? { startsOn: created.startsOn }
            : {}),
          agents: [...account.agents.filter(agent => agent.id !== created.id), created]
        }))
      );
      return created;
    },
    [client, retained, teamId]
  );

  /** Replaces one agent in place with what a write returned. */
  const putAgent = useCallback((updated: TeamAccountAgentSummary) => {
    writes.current += 1;
    setAccounts(current =>
      replaceAccount(current, updated.accountId, account => ({
        ...account,
        agents: account.agents.map(item =>
          item.id === updated.id ? { ...item, ...updated } : item
        )
      }))
    );
    return updated;
  }, []);

  const updateAgent = useCallback(
    async (agent: TeamAccountAgentSummary, agentId: string) =>
      putAgent(
        await retained('updateAccountAgent', () =>
          client.updateAccountAgent({ teamId, agentRowId: agent.id, agentId })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  const addRun = useCallback(
    async (agent: TeamAccountAgentSummary, note: string) =>
      putAgent(
        await retained('addAgentRun', () =>
          client.addAgentRun({ teamId, agentRowId: agent.id, note })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  const updateRun = useCallback(
    async (runId: string, note: string) =>
      putAgent(
        await retained('updateAgentRun', () => client.updateAgentRun({ teamId, runId, note }))
      ),
    [client, putAgent, retained, teamId]
  );

  const deleteRun = useCallback(
    async (runId: string) =>
      putAgent(await retained('deleteAgentRun', () => client.deleteAgentRun({ teamId, runId }))),
    [client, putAgent, retained, teamId]
  );

  /** The colour a press on the run landed on; null clears it. */
  const setRunMarker = useCallback(
    async (runId: string, marker: TeamAgentRunMarker | null) =>
      putAgent(
        await retained('setAgentRunMarker', () =>
          client.setAgentRunMarker({ teamId, runId, marker })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  /**
   * Takes every marker off the space in one call, and hands back what they
   * were so the toast can put them back one by one.
   */
  const clearMarkers = useCallback(async () => {
    const cleared = await retained('clearAgentRunMarkers', () =>
      client.clearAgentRunMarkers({ teamId })
    );
    writes.current += 1;
    setAccounts(current =>
      current.map(account => ({
        ...account,
        agents: account.agents.map(agent => ({
          ...agent,
          runs: agent.runs.map(run => (run.marker === null ? run : { ...run, marker: null }))
        }))
      }))
    );
    return cleared;
  }, [client, retained, teamId]);

  /** Frees the agent: every run goes at once. */
  const clearRuns = useCallback(
    async (agent: TeamAccountAgentSummary) =>
      putAgent(
        await retained('clearAgentRuns', () =>
          client.clearAgentRuns({ teamId, agentRowId: agent.id })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  const attachLabel = useCallback(
    async (agent: TeamAccountAgentSummary, labelId: string) =>
      putAgent(
        await retained('attachAgentLabel', () =>
          client.attachAgentLabel({ teamId, agentRowId: agent.id, labelId })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  const detachLabel = useCallback(
    async (agent: TeamAccountAgentSummary, labelId: string) =>
      putAgent(
        await retained('detachAgentLabel', () =>
          client.detachAgentLabel({ teamId, agentRowId: agent.id, labelId })
        )
      ),
    [client, putAgent, retained, teamId]
  );

  const deleteAgent = useCallback(
    async (agent: TeamAccountAgentSummary) => {
      await retained('deleteAccountAgent', () =>
        client.deleteAccountAgent({ teamId, agentRowId: agent.id })
      );
      writes.current += 1;
      setAccounts(current =>
        replaceAccount(current, agent.accountId, account => ({
          ...account,
          agents: account.agents.filter(item => item.id !== agent.id)
        }))
      );
    },
    [client, retained, teamId]
  );

  return {
    accounts,
    orderVersions,
    launchSummaries,
    launchCoverage,
    loading,
    error,
    refetch,
    createAccount,
    renameAccount,
    deleteAccount,
    setAccountTwoFactor,
    addAgent,
    updateAgent,
    deleteAgent,
    addRun,
    updateRun,
    deleteRun,
    setRunMarker,
    clearMarkers,
    clearRuns,
    attachLabel,
    detachLabel
  };
}
