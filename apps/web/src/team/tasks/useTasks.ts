import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  isTeamTaskSort,
  localTaskDayBounds,
  TEAM_TASK_STATUSES,
  teamTaskComparator,
  type TeamTaskLabelRef,
  type TeamTaskPatch,
  type TeamTaskSort,
  type TeamTaskStatus,
  type TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { oneOf, persistedViewKey, stringList, usePersistedState } from '../persistedView';
import { getSupabaseClient } from '../../lib/supabase';

export type TaskDateFilter = { kind: 'all' } | { kind: 'range'; from: string; to: string };
export type TaskStatusFilter = 'all' | TeamTaskStatus;
/**
 * Which accounts' tasks the list shows (017): everything, one account's, or
 * one agent's. Carried by the address, so the Accounts tab can link to it.
 */
export type TaskAccountScope =
  { kind: 'all' } | { kind: 'account'; accountId: string } | { kind: 'agent'; agentRowId: string };

/**
 * Whose tasks the board shows (018): everyone's, one person's, or the ones
 * nobody is on. "Nobody" is a state of its own rather than a missing id — it
 * is the pile a stand-up is held over.
 */
export type TaskAssigneeFilter =
  { kind: 'all' } | { kind: 'member'; userId: string } | { kind: 'unassigned' };

/**
 * The ranges people actually ask for, one press each. The calendar answers
 * everything else, but reaching it for "today" was four interactions for the
 * commonest question there is.
 */
export type QuickRange = 'today' | 'yesterday' | 'month' | 'all';

export function quickRangeValue(range: Exclude<QuickRange, 'all'>, now: Date): TaskDateFilter {
  if (range === 'today') {
    const today = localDateValue(now);
    return { kind: 'range', from: today, to: today };
  }
  if (range === 'yesterday') {
    const yesterday = localDateValue(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
    );
    return { kind: 'range', from: yesterday, to: yesterday };
  }
  // The whole month, first to last: a task can be dated ahead of today (017),
  // and "This month" that stopped at today would hide the half of the month a
  // person plans in.
  return {
    kind: 'range',
    from: localDateValue(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
    to: localDateValue(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12))
  };
}

export function activeQuickRange(value: TaskDateFilter, now: Date): QuickRange | null {
  if (value.kind === 'all') return 'all';
  for (const range of ['today', 'yesterday', 'month'] as const) {
    const candidate = quickRangeValue(range, now);
    if (candidate.kind === 'range' && candidate.from === value.from && candidate.to === value.to) {
      return range;
    }
  }
  return null;
}

/**
 * A quick range is stored by name, so "today" means today after tomorrow's reload rather than the
 * day it was pressed; a range picked on the calendar is stored as its days.
 */
function encodeDateFilter(value: TaskDateFilter): unknown {
  const quick = activeQuickRange(value, new Date());
  return quick && quick !== 'all' ? { kind: 'quick', range: quick } : value;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function parseStoredDateFilter(value: unknown): TaskDateFilter | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'all') return { kind: 'all' };
  if (
    record.kind === 'quick' &&
    (record.range === 'today' || record.range === 'yesterday' || record.range === 'month')
  ) {
    return quickRangeValue(record.range, new Date());
  }
  if (
    record.kind === 'range' &&
    typeof record.from === 'string' &&
    typeof record.to === 'string' &&
    DAY.test(record.from) &&
    DAY.test(record.to)
  ) {
    return { kind: 'range', from: record.from, to: record.to };
  }
  return null;
}

function parseAssigneeFilter(value: unknown): TaskAssigneeFilter | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'all' || record.kind === 'unassigned') return { kind: record.kind };
  if (record.kind === 'member' && typeof record.userId === 'string' && record.userId.length > 0) {
    return { kind: 'member', userId: record.userId };
  }
  return null;
}

export interface TasksClient {
  listTasks(input: {
    teamId: string;
    createdFrom?: string | null;
    createdTo?: string | null;
    /** The same range in plain days, for tasks carrying a date of their own. */
    dayFrom?: string | null;
    dayTo?: string | null;
    status?: TeamTaskStatus | null;
    agentRowId?: string | null;
    accountId?: string | null;
    /** Only tasks carrying any of these tags (018). */
    labelIds?: readonly string[] | null;
    /** How the server orders the page (018). */
    sort?: TeamTaskSort | null;
    /** Only one person's tasks (018 part 2). */
    assigneeId?: string | null;
    /** Only the tasks nobody is on. */
    unassigned?: boolean;
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

/**
 * The chosen range in both forms the list needs: instants, which are exact for
 * a task that has only the moment it was created, and plain local days, which
 * are exact for a task that carries a date of its own. Sending both is what
 * keeps the board from having to guess a timezone in SQL.
 */
export function taskFilterBounds(filter: TaskDateFilter) {
  if (filter.kind === 'all') return null;
  const from = filter.from <= filter.to ? filter.from : filter.to;
  const to = filter.from <= filter.to ? filter.to : filter.from;
  return {
    from: localTaskDayBounds(from).from,
    to: localTaskDayBounds(to).to,
    dayFrom: from,
    dayTo: to
  };
}

function mergeTasks(current: TeamTaskSummary[], incoming: TeamTaskSummary[], sort: TeamTaskSort) {
  const byId = new Map(current.map(task => [task.id, task]));
  for (const task of incoming) byId.set(task.id, task);
  // The same order the server pages in: by the date the task is for, or by
  // tag when that is what the board is ordered by.
  return [...byId.values()].sort(teamTaskComparator(sort));
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
  // Every choice below is the space's and outlives a reload (persistedView).
  const [filter, setFilter] = usePersistedState<TaskDateFilter>(
    persistedViewKey(teamId, 'tasks.date'),
    { kind: 'all' },
    parseStoredDateFilter,
    encodeDateFilter
  );
  const [statusFilter, setStatusFilter] = usePersistedState<TaskStatusFilter>(
    persistedViewKey(teamId, 'tasks.status'),
    'all',
    oneOf<TaskStatusFilter>(['all', ...TEAM_TASK_STATUSES])
  );
  /** Which tags the board is narrowed to, and what it is ordered by (018). */
  const [labelIds, setLabelIds] = usePersistedState<string[]>(
    persistedViewKey(teamId, 'tasks.labels'),
    [],
    stringList()
  );
  const [sort, setSort] = usePersistedState<TeamTaskSort>(
    persistedViewKey(teamId, 'tasks.sort'),
    'date',
    value => (isTeamTaskSort(value) ? value : null)
  );
  /** Whose tasks the board shows (018 part 2). */
  const [assignee, setAssignee] = usePersistedState<TaskAssigneeFilter>(
    persistedViewKey(teamId, 'tasks.assignee'),
    { kind: 'all' },
    parseAssigneeFilter
  );
  const bounds = useMemo(() => taskFilterBounds(filter), [filter]);
  const status = statusFilter === 'all' ? null : statusFilter;
  const agentRowId = scope.kind === 'agent' ? scope.agentRowId : null;
  const accountId = scope.kind === 'account' ? scope.accountId : null;
  /* One string for the chosen set, sorted so the same two tags in either
     order are the same view — it is the cache key, the request's argument and
     the effect's dependency, so a re-press that changes nothing re-reads
     nothing. */
  const labelKey = [...labelIds].sort().join(',');
  const labelFilter = useMemo(() => (labelKey === '' ? null : labelKey.split(',')), [labelKey]);
  const assigneeId = assignee.kind === 'member' ? assignee.userId : null;
  const unassigned = assignee.kind === 'unassigned';
  const cacheKey = [
    teamId,
    bounds?.from ?? '',
    bounds?.to ?? '',
    status ?? '',
    agentRowId ?? '',
    accountId ?? '',
    labelKey,
    sort,
    assigneeId ?? (unassigned ? 'none' : '')
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
        dayFrom: bounds?.dayFrom,
        dayTo: bounds?.dayTo,
        status,
        agentRowId,
        accountId,
        labelIds: labelFilter,
        sort,
        assigneeId,
        unassigned,
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
  }, [
    accountId,
    agentRowId,
    assigneeId,
    bounds?.from,
    bounds?.to,
    cacheKey,
    client,
    labelFilter,
    sort,
    status,
    teamId,
    unassigned
  ]);

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
      // The tags a card shows (018) and the dictionary they read their name
      // and colour from: a rename by one person must reach everyone's board.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_task_label_links',
          filter: `team_id=eq.${teamId}`
        },
        scheduleRefetch
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_task_labels', filter: `team_id=eq.${teamId}` },
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
        dayFrom: bounds?.dayFrom,
        dayTo: bounds?.dayTo,
        status,
        agentRowId,
        accountId,
        labelIds: labelFilter,
        sort,
        assigneeId,
        unassigned,
        cursor,
        pageSize: PAGE_SIZE
      });
      setTasks(current => mergeTasks(current, next, sort));
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
    assigneeId,
    bounds?.from,
    bounds?.to,
    client,
    hasMore,
    labelFilter,
    loading,
    loadingMore,
    sort,
    status,
    tasks,
    teamId,
    unassigned
  ]);

  const create = useCallback(
    async (input: {
      title: string;
      note?: string | null;
      assigneeId?: string | null;
      initialMaterialId?: string | null;
    }) => {
      const created = await client.createTask({ teamId, ...input });
      setTasks(current => mergeTasks(current, [created], sort));
      return created;
    },
    [client, sort, teamId]
  );

  const update = useCallback(
    async (
      task: TeamTaskSummary,
      patch: TeamTaskPatch,
      options: { checkVersion?: boolean } = {}
    ) => {
      /*
       * A one-field edit from a card (progress, status) is last-writer-wins: it cannot clobber
       * another field, and holding it to the card's copy of `updatedAt` refused it whenever the task
       * had changed anywhere else — tags, attachments, another tab — and the progress was lost.
       */
      const updated = await client.updateTask(teamId, task.id, {
        ...patch,
        ...(options.checkVersion === false ? {} : { expectedUpdatedAt: task.updatedAt })
      });
      // update_team_task returns a team_tasks row, which deliberately does not
      // include the derived attachment count. A quick status/progress edit must
      // not make an otherwise attached card briefly look empty.
      const next = {
        ...updated,
        attachmentCount: task.attachmentCount,
        agents: task.agents,
        labels: task.labels
      };
      // An edit can move a task's date, and the board is ordered by that date:
      // re-place the card instead of leaving it where it used to belong.
      setTasks(current =>
        current.map(item => (item.id === next.id ? next : item)).sort(teamTaskComparator(sort))
      );
      return next;
    },
    [client, sort, teamId]
  );

  /** The editor hung or removed a tag (018); the card follows at once. */
  const setTaskLabels = useCallback(
    (taskId: string, labels: TeamTaskLabelRef[]) => {
      setTasks(current =>
        current
          .map(item => (item.id === taskId ? { ...item, labels } : item))
          // Under "by tag" a tag written now moves the card; leaving it where
          // it was would put it under a tag it no longer carries.
          .sort(teamTaskComparator(sort))
      );
    },
    [sort]
  );

  /** The editor tagged or untagged a task; the card follows without a round trip. */
  const setTaskAgents = useCallback((taskId: string, agents: TeamTaskSummary['agents']) => {
    setTasks(current => current.map(item => (item.id === taskId ? { ...item, agents } : item)));
  }, []);

  return {
    tasks,
    setTaskAgents,
    setTaskLabels,
    filter,
    setFilter,
    statusFilter,
    setStatusFilter,
    labelIds,
    setLabelIds,
    sort,
    setSort,
    assignee,
    setAssignee,
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
