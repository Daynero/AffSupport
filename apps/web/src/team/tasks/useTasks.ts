import { isOlderRowVersion, useScopedRows } from '../useScopedRows';
import { withReadDeadline } from '../readCoordinator';
import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useOptionalTeam } from '../TeamContext';
import { realtimeTopic } from '../../lib/realtimeTopic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  filterBySearchQuery,
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
export function encodeDateFilter(value: TaskDateFilter): unknown {
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
    cursor?: string | null;
    pageSize?: number;
    signal?: AbortSignal;
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
  for (const task of incoming) {
    const existing = byId.get(task.id);
    if (!existing || !isOlderRowVersion(task, existing)) byId.set(task.id, task);
  }
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
  const auth = useOptionalAuth();
  const team = useOptionalTeam();
  const identityScope = JSON.stringify([
    auth?.user?.id ?? null,
    teamId,
    team?.permissions ?? null,
    team?.accessRevision ?? 0
  ]);
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
  /**
   * A word from the title or the brief (024, FR-077).
   *
   * Filtered here rather than on the server: the board holds a page of tasks
   * that is already narrowed by date, status, account and tag, so
   * the fastest way to the one you mean is to type two letters of it — and a
   * round trip for two letters would be slower than the eye.
   */
  const [query, setQuery] = usePersistedState<string>(
    persistedViewKey(teamId, 'tasks.query'),
    '',
    value => (typeof value === 'string' ? value : null)
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
  const cacheKey = [
    teamId,
    bounds?.from ?? '',
    bounds?.to ?? '',
    status ?? '',
    agentRowId ?? '',
    accountId ?? '',
    labelKey,
    sort
  ].join('|');
  const {
    commit,
    rows: tasks,
    setRows: setTasks,
    hasMore,
    setHasMore,
    loading,
    setLoading,
    error,
    setError,
    generation,
    writes,
    reading: readingFirstPage,
    lifetime: scopeLifetime,
    lifetimeKey,
    cached
  } = useScopedRows<TeamTaskSummary>(identityScope, cacheKey, client, client === defaultClient);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRead = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pageRead.current?.abort();
    },
    []
  );
  useEffect(() => {
    setLoadingMore(false);
    return () => {
      pageRead.current?.abort();
      pageRead.current = null;
    };
  }, [identityScope, cacheKey]);

  const read = useCallback(
    async (signal: AbortSignal, deferFresh: () => void) => {
      pageRead.current?.abort();
      pageRead.current = null;
      setLoadingMore(false);
      readingFirstPage.current = true;
      const requestGeneration = ++generation.current;
      const writesBefore = writes.current;
      // A cached page stays on screen while it is re-read; the loading line is
      // for a view never seen before, or one whose filters just changed.
      if (!cached) setLoading(true);
      try {
        const next = await withReadDeadline(
          readSignal =>
            client.listTasks({
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
              pageSize: PAGE_SIZE,
              signal: readSignal
            }),
          signal
        );
        if (
          signal.aborted ||
          requestGeneration !== generation.current ||
          writesBefore !== writes.current
        ) {
          if (
            !signal.aborted &&
            requestGeneration === generation.current &&
            writesBefore !== writes.current
          )
            deferFresh();
          return;
        }
        setTasks(next);
        setHasMore(next.length === PAGE_SIZE);
        setError(null);
      } catch (cause) {
        if (!signal.aborted && requestGeneration === generation.current) {
          setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
        }
      } finally {
        if (requestGeneration === generation.current) readingFirstPage.current = false;
        if (!signal.aborted && requestGeneration === generation.current) setLoading(false);
      }
    },
    [
      accountId,
      agentRowId,
      bounds?.from,
      bounds?.to,
      cacheKey,
      cached,
      identityScope,
      client,
      labelFilter,
      sort,
      status,
      teamId
    ]
  );

  const refetch = useVisibleSerialRead({
    client,
    scopeKey: identityScope + cacheKey,
    revision,
    read
  });

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
      .channel(realtimeTopic(`team-tasks:${teamId}`))
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
    if (!scopeLifetime.current.active || scopeLifetime.current.key !== lifetimeKey) return;
    const cursor = tasks.at(-1)?.id;
    if (
      !cursor ||
      !hasMore ||
      loading ||
      loadingMore ||
      pageRead.current ||
      readingFirstPage.current
    )
      return;
    const lifetime = lifetimeKey;
    const writesBefore = writes.current;
    const controller = new AbortController();
    pageRead.current = controller;
    const current = () =>
      !controller.signal.aborted &&
      scopeLifetime.current.active &&
      scopeLifetime.current.key === lifetime &&
      writesBefore === writes.current;
    setLoadingMore(true);
    try {
      const next = await withReadDeadline(
        readSignal =>
          client.listTasks({
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
            cursor,
            pageSize: PAGE_SIZE,
            signal: readSignal
          }),
        controller.signal
      );
      if (!current()) return;
      setTasks(current => mergeTasks(current, next, sort));
      setHasMore(next.length === PAGE_SIZE);
      setError(null);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
    } finally {
      if (pageRead.current === controller) pageRead.current = null;
      if (!controller.signal.aborted && scopeLifetime.current.key === lifetime)
        setLoadingMore(false);
    }
  }, [
    accountId,
    agentRowId,
    bounds?.from,
    bounds?.to,
    client,
    hasMore,
    labelFilter,
    loading,
    loadingMore,
    lifetimeKey,
    sort,
    status,
    tasks,
    teamId
  ]);

  const create = useCallback(
    (input: {
      title: string;
      note?: string | null;
      assigneeId?: string | null;
      initialMaterialId?: string | null;
    }) =>
      commit(
        () => client.createTask({ teamId, ...input }),
        created => setTasks(current => mergeTasks(current, [created], sort)),
        refetch
      ),
    [client, commit, refetch, sort, teamId]
  );

  const update = useCallback(
    (task: TeamTaskSummary, patch: TeamTaskPatch, options: { checkVersion?: boolean } = {}) =>
      commit(
        async () => {
          const updated = await client.updateTask(teamId, task.id, {
            ...patch,
            ...(options.checkVersion === false ? {} : { expectedUpdatedAt: task.updatedAt })
          });
          // The bare write row does not include derived counts, agents or labels.
          return {
            ...updated,
            attachmentCount: task.attachmentCount,
            agents: task.agents,
            labels: task.labels
          };
        },
        next => {
          const stillShown = status === null || next.status === status;
          setTasks(current =>
            current
              .flatMap(item => {
                if (item.id !== next.id || isOlderRowVersion(next, item)) return [item];
                return stillShown
                  ? [
                      {
                        ...next,
                        attachmentCount: item.attachmentCount,
                        agents: item.agents,
                        labels: item.labels
                      }
                    ]
                  : [];
              })
              .sort(teamTaskComparator(sort))
          );
        },
        refetch
      ),
    [client, commit, refetch, sort, status, teamId]
  );

  /** The editor hung or removed a tag (018); the card follows at once. */
  const setTaskLabels = useCallback(
    (taskId: string, labels: TeamTaskLabelRef[]) => {
      if (!scopeLifetime.current.active || scopeLifetime.current.key !== lifetimeKey) return;
      writes.current += 1;
      setTasks(current =>
        current
          .map(item => (item.id === taskId ? { ...item, labels } : item))
          // Under "by tag" a tag written now moves the card; leaving it where
          // it was would put it under a tag it no longer carries.
          .sort(teamTaskComparator(sort))
      );
      if (readingFirstPage.current) void refetch();
    },
    [lifetimeKey, refetch, sort]
  );

  /** The editor tagged or untagged a task; the card follows without a round trip. */
  const setTaskAgents = useCallback(
    (taskId: string, agents: TeamTaskSummary['agents']) => {
      if (!scopeLifetime.current.active || scopeLifetime.current.key !== lifetimeKey) return;
      writes.current += 1;
      setTasks(current => current.map(item => (item.id === taskId ? { ...item, agents } : item)));
      if (readingFirstPage.current) void refetch();
    },
    [lifetimeKey, refetch]
  );

  const term = query.normalize('NFC').trim();
  /*
   * Done goes to the end (024): before a launch the board is read for what is still open, and
   * finished cards mixed in between pushed it down. Where a card sits is decided when the board
   * first shows it, not on every status change — a card marked done right now stays under the
   * pointer until the board is next read (a filter, a sort, another space), so nothing jumps
   * away from the press that changed it.
   */
  const placedDone = useRef(new Map<string, boolean>());
  const boardKey = `${teamId}|${JSON.stringify(filter)}|${statusFilter}|${sort}|${agentRowId}|${accountId}|${labelIds.join(',')}`;
  const placedFor = useRef(boardKey);
  if (placedFor.current !== boardKey) {
    placedFor.current = boardKey;
    placedDone.current = new Map();
  }
  const shown = useMemo(() => {
    /* Every word, in any order, and the other keyboard layout when the words as
       typed find nothing — the way files are found (search rework, 2026-10). */
    const matching =
      term === '' ? tasks : filterBySearchQuery(tasks, term, task => [task.title, task.note]).items;
    const placed = placedDone.current;
    for (const task of matching) {
      if (!placed.has(task.id)) placed.set(task.id, task.status === 'done');
    }
    return [
      ...matching.filter(task => !placed.get(task.id)),
      ...matching.filter(task => placed.get(task.id))
    ];
    // boardKey resets the placement; it is read through the ref above.
  }, [tasks, term, boardKey]);

  return {
    tasks: shown,
    /** Everything the page holds, before the search narrows it. */
    allTasks: tasks,
    query,
    setQuery,
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
