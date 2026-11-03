import { isOlderRowVersion, useScopedRows } from '../useScopedRows';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useOptionalTeam } from '../TeamContext';
import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { withReadDeadline } from '../readCoordinator';
import { realtimeTopic } from '../../lib/realtimeTopic';
import { useCallback, useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  sortTeamTaskLabels,
  type TeamLabelScope,
  type TeamTaskLabel,
  type TeamTaskLabelColor
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { getSupabaseClient } from '../../lib/supabase';

/**
 * The client seam for the tag dictionary (018): what the settings tab and the
 * task pickers need of the API and nothing more, so a test can hand it a stub.
 */
export interface TaskLabelsClient {
  listTaskLabels(
    teamId: string,
    scope?: TeamLabelScope,
    options?: { signal?: AbortSignal }
  ): Promise<TeamTaskLabel[]>;
  createTaskLabel(input: {
    teamId: string;
    name: string;
    color: TeamTaskLabelColor;
    scope?: TeamLabelScope;
  }): Promise<TeamTaskLabel>;
  updateTaskLabel(input: {
    teamId: string;
    labelId: string;
    name: string;
    color: TeamTaskLabelColor;
  }): Promise<TeamTaskLabel>;
  deleteTaskLabel(input: { teamId: string; labelId: string }): Promise<true>;
}

const defaultClient: TaskLabelsClient = teamApi;

/**
 * The tags of a space, kept live.
 *
 * Every write applies the row the server returned straight into local state,
 * so the person who made the change sees it at once; the realtime channel is
 * for everyone else. The list is small — tens of tags at most, capped in the
 * database — so there is no paging and no partial refetch.
 */
export function useTaskLabels({
  teamId,
  revision = 0,
  scope = 'task',
  client = defaultClient
}: {
  teamId: string;
  revision?: number;
  /** Which set: the tags on tasks, or the tags on agents (019). */
  scope?: TeamLabelScope;
  client?: TaskLabelsClient;
}) {
  const auth = useOptionalAuth();
  const team = useOptionalTeam();
  const identity = JSON.stringify([
    auth?.user?.id ?? null,
    teamId,
    team?.permissions,
    team?.accessRevision
  ]);
  const {
    commit,
    rows: labels,
    setRows: setLabels,
    loading,
    setLoading,
    error,
    setError,
    generation,
    writes,
    reading,
    lifetimeKey
  } = useScopedRows<TeamTaskLabel>(identity, scope, client, client === defaultClient);
  const read = useCallback(
    async (signal: AbortSignal, deferFresh: () => void) => {
      const requestGeneration = ++generation.current;
      const writesBefore = writes.current;
      reading.current = true;
      try {
        const next = await withReadDeadline(
          readSignal => client.listTaskLabels(teamId, scope, { signal: readSignal }),
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
        setLabels(sortTeamTaskLabels(next));
        setError(null);
      } catch (cause) {
        if (!signal.aborted && requestGeneration === generation.current)
          setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      } finally {
        if (requestGeneration === generation.current) {
          reading.current = false;
          if (!signal.aborted) setLoading(false);
        }
      }
    },
    [client, lifetimeKey, scope, teamId]
  );
  const refetch = useVisibleSerialRead({ client, scopeKey: lifetimeKey, revision, read });
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    // A custom client is a test or preview data source; it is never wired to
    // the production channel.
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
      .channel(realtimeTopic(`team-labels:${scope}:${teamId}`))
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_labels', filter: `team_id=eq.${teamId}` },
        scheduleRefetch
      )
      // The count beside each tag is how many tasks carry it; a teammate
      // tagging a task changes it without touching the tag itself.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: scope === 'task' ? 'team_task_label_links' : 'team_agent_labels',
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
  }, [client, scope, teamId]);

  const create = useCallback(
    (name: string, color: TeamTaskLabelColor) =>
      commit(
        () => client.createTaskLabel({ teamId, name, color, scope }),
        created =>
          setLabels(current =>
            current.some(label => label.id === created.id)
              ? current
              : sortTeamTaskLabels([...current, created])
          ),
        refetch
      ),
    [client, commit, refetch, scope, teamId]
  );
  const update = useCallback(
    (labelId: string, name: string, color: TeamTaskLabelColor) =>
      commit(
        () => client.updateTaskLabel({ teamId, labelId, name, color }),
        updated =>
          setLabels(current =>
            sortTeamTaskLabels(
              current.map(label =>
                label.id === labelId && !isOlderRowVersion(updated, label)
                  ? { ...updated, taskCount: label.taskCount }
                  : label
              )
            )
          ),
        refetch
      ),
    [client, commit, refetch, teamId]
  );
  const remove = useCallback(
    async (labelId: string) => {
      await commit(
        () => client.deleteTaskLabel({ teamId, labelId }),
        () => setLabels(current => current.filter(label => label.id !== labelId)),
        refetch
      );
    },
    [client, commit, refetch, teamId]
  );

  return { labels, loading, error, refetch, create, update, remove };
}
