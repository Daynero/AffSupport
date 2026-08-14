import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  localTaskDayBounds,
  type TeamTaskPatch,
  type TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';

export type TaskDateFilter =
  { kind: 'all' } | { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; date: string };

export interface TasksClient {
  listTasks(input: {
    teamId: string;
    createdFrom?: string | null;
    createdTo?: string | null;
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

export function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function taskFilterBounds(filter: TaskDateFilter, now = new Date()) {
  if (filter.kind === 'all') return null;
  if (filter.kind === 'date') return localTaskDayBounds(filter.date);
  const date = new Date(now);
  if (filter.kind === 'yesterday') date.setDate(date.getDate() - 1);
  return localTaskDayBounds(localDateValue(date));
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
  client = defaultClient
}: {
  teamId: string;
  revision?: number;
  client?: TasksClient;
}) {
  const [tasks, setTasks] = useState<TeamTaskSummary[]>([]);
  const [filter, setFilter] = useState<TaskDateFilter>({ kind: 'today' });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const bounds = useMemo(() => taskFilterBounds(filter), [filter]);

  const refetch = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const next = await client.listTasks({
        teamId,
        createdFrom: bounds?.from,
        createdTo: bounds?.to,
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
  }, [bounds?.from, bounds?.to, client, teamId]);

  useEffect(() => {
    void refetch();
    return () => {
      generation.current += 1;
    };
  }, [refetch, revision]);

  const loadMore = useCallback(async () => {
    const cursor = tasks.at(-1)?.id;
    if (!cursor || !hasMore || loading || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.listTasks({
        teamId,
        createdFrom: bounds?.from,
        createdTo: bounds?.to,
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
  }, [bounds?.from, bounds?.to, client, hasMore, loading, loadingMore, tasks, teamId]);

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
      setTasks(current => current.map(item => (item.id === updated.id ? updated : item)));
      return updated;
    },
    [client, teamId]
  );

  return {
    tasks,
    filter,
    setFilter,
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
