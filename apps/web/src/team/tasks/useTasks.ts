import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  localTaskDayBounds,
  type TeamTaskPatch,
  type TeamTaskStatus,
  type TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { getSupabaseClient } from '../../lib/supabase';

export type TaskDateFilter = { kind: 'all' } | { kind: 'range'; from: string; to: string };
export type TaskStatusFilter = 'all' | TeamTaskStatus;
/**
 * Which accounts' tasks the list shows (017): everything, one account's, or
 * one agent's. Carried by the address, so the Accounts tab can link to it.
 */
export type TaskAccountScope =
  { kind: 'all' } | { kind: 'account'; accountId: string } | { kind: 'agent'; agentRowId: string };

export interface TasksClient {
  listTasks(input: {
    teamId: string;
    createdFrom?: string | null;
    createdTo?: string | null;
    status?: TeamTaskStatus | null;
    agentRowId?: string | null;
    accountId?: string | null;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<TeamTaskSummary[]>;
  createTask(input: {
    teamId: string;
    title: string;
    note?: string | null;
    assigneeId?: string | null;
    initialMaterialId?: string | null;
  }): Promise<TeamTaskSummary>;
  updateTask(teamId: string, taskId: string, patch: TeamTaskPatch): Promise<TeamTaskSummary>;
}

const defaultClient: TasksClient = teamApi;
const PAGE_SIZE = 50;

/**
 * The last first page each (space, filters) pair showed, for the life of the
 * page. The Tasks section unmounts on every trip to another tab; without this
 * every return began with "Loading…". Realtime re-reads on anyone's change,
 * so the cached page is at most a moment old. Production client only.
 */
const cache = new Map<string, { tasks: TeamTaskSummary[]; hasMore: boolean }>();

export function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function taskFilterBounds(filter: TaskDateFilter) {
  if (filter.kind === 'all') return null;
  const from = filter.from <= filter.to ? filter.from : filter.to;
  const to = filter.from <= filter.to ? filter.to : filter.from;
  return {
    from: localTaskDayBounds(from).from,
    to: localTaskDayBounds(to).to
  };
}

function mergeTasks(current: TeamTaskSummary[], incoming: TeamTaskSummary[]) {
  const byId = new Map(current.map(task => [task.id, task]));
  for (const task of incoming) byId.set(task.id, task);
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  );
}

export function useTasks({
  teamId,
  revision = 0,
  scope = { kind: 'all' },
  client = defaultClient
}: {
  teamId: string;
  revision?: number;
  scope?: TaskAccountScope;
  client?: TasksClient;
}) {
  const [filter, setFilter] = useState<TaskDateFilter>({ kind: 'all' });
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const bounds = useMemo(() => taskFilterBounds(filter), [filter]);
  const status = statusFilter === 'all' ? null : statusFilter;
  const agentRowId = scope.kind === 'agent' ? scope.agentRowId : null;
  const accountId = scope.kind === 'account' ? scope.accountId : null;
  const cacheKey = [
    teamId,
    bounds?.from ?? '',
    bounds?.to ?? '',
    status ?? '',
    agentRowId ?? '',
    accountId ?? ''
  ].join('|');
  const cached = client === defaultClient ? cache.get(cacheKey) : undefined;
  const [tasks, setTasks] = useState<TeamTaskSummary[]>(cached?.tasks ?? []);
  const [loading, setLoading] = useState(cached === undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(async () => {
    const requestGeneration = ++generation.current;
    // A cached page stays on screen while it is re-read; the loading line is
    // for a view never seen before, or one whose filters just changed.
    if (!(client === defaultClient && cache.has(cacheKey))) setLoading(true);
    try {
      const next = await client.listTasks({
        teamId,
        createdFrom: bounds?.from,
        createdTo: bounds?.to,
        status,
        agentRowId,
        accountId,
        pageSize: PAGE_SIZE
      });
      if (requestGeneration !== generation.current) return;
      setTasks(next);
      setHasMore(next.length === PAGE_SIZE);
      setError(null);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [accountId, agentRowId, bounds?.from, bounds?.to, cacheKey, client, status, teamId]);

  useEffect(() => {
    void refetch();
    return () => {
      generation.current += 1;
    };
  }, [refetch, revision]);

  // Filters changed: show that view's last page at once if there is one.
  useEffect(() => {
    if (client !== defaultClient) return;
    const entry = cache.get(cacheKey);
    if (entry) {
      setTasks(entry.tasks);
      setHasMore(entry.hasMore);
    }
  }, [cacheKey, client]);

  useEffect(() => {
    if (client === defaultClient && !loading) cache.set(cacheKey, { tasks, hasMore });
  }, [cacheKey, client, hasMore, loading, tasks]);

  // Live sync: refetch whenever any team member creates, edits, or (de)attaches
  // a task. The team_tasks / team_task_attachments tables are published over
  // Supabase Realtime (RLS-scoped to team viewers), so peers see changes without
  // reopening the workspace. A ref keeps the subscription stable across filter
  // changes while always refetching with the current filters.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    // A custom client is normally an isolated/test data source, so it cannot
    // safely be kept in sync with the production Realtime channel.
    if (client !== defaultClient) return;
    const supabase = getSupabaseClient();
    if (!supabase || !teamId) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (!active) return;
      // Coalesce bursts (e.g. a peer attaching many materials at once).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refetchRef.current();
      }, 300);
    };

    const channel: RealtimeChannel = supabase
      .channel(`team-tasks:${teamId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_tasks', filter: `team_id=eq.${teamId}` },
        scheduleRefetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_task_attachments',
          filter: `team_id=eq.${teamId}`
        },
        scheduleRefetch
      )
      // The tags a card shows (017) — and whether each tagged agent is free —
      // live in two more tables. A teammate marking a run must turn the dot
      // on the card without a reload.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_task_agents', filter: `team_id=eq.${teamId}` },
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
      .subscribe();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [client, teamId]);

  const loadMore = useCallback(async () => {
    const cursor = tasks.at(-1)?.id;
    if (!cursor || !hasMore || loading || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.listTasks({
        teamId,
        createdFrom: bounds?.from,
        createdTo: bounds?.to,
        status,
        agentRowId,
        accountId,
        cursor,
        pageSize: PAGE_SIZE
      });
      setTasks(current => mergeTasks(current, next));
      setHasMore(next.length === PAGE_SIZE);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
    } finally {
      setLoadingMore(false);
    }
  }, [
    accountId,
    agentRowId,
    bounds?.from,
    bounds?.to,
    client,
    hasMore,
    loading,
    loadingMore,
    status,
    tasks,
    teamId
  ]);

  const create = useCallback(
    async (input: {
      title: string;
      note?: string | null;
      assigneeId?: string | null;
      initialMaterialId?: string | null;
    }) => {
      const created = await client.createTask({ teamId, ...input });
      setTasks(current => mergeTasks(current, [created]));
      return created;
    },
    [client, teamId]
  );

  const update = useCallback(
    async (task: TeamTaskSummary, patch: TeamTaskPatch) => {
      const updated = await client.updateTask(teamId, task.id, {
        ...patch,
        expectedUpdatedAt: task.updatedAt
      });
      // update_team_task returns a team_tasks row, which deliberately does not
      // include the derived attachment count. A quick status/progress edit must
      // not make an otherwise attached card briefly look empty.
      const next = { ...updated, attachmentCount: task.attachmentCount, agents: task.agents };
      setTasks(current => current.map(item => (item.id === next.id ? next : item)));
      return next;
    },
    [client, teamId]
  );

  /** The editor tagged or untagged a task; the card follows without a round trip. */
  const setTaskAgents = useCallback((taskId: string, agents: TeamTaskSummary['agents']) => {
    setTasks(current => current.map(item => (item.id === taskId ? { ...item, agents } : item)));
  }, []);

  return {
    tasks,
    setTaskAgents,
    filter,
    setFilter,
    statusFilter,
    setStatusFilter,
    loading,
    loadingMore,
    hasMore,
    error,
    refetch,
    loadMore,
    create,
    update
  };
}
