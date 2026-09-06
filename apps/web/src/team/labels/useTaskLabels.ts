import { useCallback, useEffect, useRef, useState } from 'react';
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
  listTaskLabels(teamId: string, scope?: TeamLabelScope): Promise<TeamTaskLabel[]>;
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
 * The last dictionary each space showed, for the life of the page. The tags
 * are read by three surfaces that mount and unmount constantly — the settings
 * tab, the editor's picker, the board's filter — and none of them should
 * begin with "Loading…" over a list that has not changed in a week.
 */
const cache = new Map<string, TeamTaskLabel[]>();

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
  const cacheKey = `${teamId}:${scope}`;
  const cached = client === defaultClient ? cache.get(cacheKey) : undefined;
  const [labels, setLabels] = useState<TeamTaskLabel[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refetch = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      const next = await client.listTaskLabels(teamId, scope);
      if (requestGeneration !== generation.current) return;
      setLabels(sortTeamTaskLabels(next));
      setError(null);
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'INVALID_RESPONSE');
      }
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [client, scope, teamId]);

  useEffect(() => {
    if (!(client === defaultClient && cache.has(cacheKey))) setLoading(true);
    void refetch();
    return () => {
      generation.current += 1;
    };
  }, [cacheKey, client, refetch, revision]);

  useEffect(() => {
    if (client === defaultClient && !loading) cache.set(cacheKey, labels);
  }, [cacheKey, client, labels, loading]);

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
      .channel(`team-labels:${scope}:${teamId}`)
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
    async (name: string, color: TeamTaskLabelColor) => {
      const created = await client.createTaskLabel({ teamId, name, color, scope });
      setLabels(current => sortTeamTaskLabels([...current, created]));
      return created;
    },
    [client, scope, teamId]
  );

  const update = useCallback(
    async (labelId: string, name: string, color: TeamTaskLabelColor) => {
      const updated = await client.updateTaskLabel({ teamId, labelId, name, color });
      setLabels(current =>
        sortTeamTaskLabels(
          // The write returns the bare row, which carries no count: the tag
          // kept the tasks it had, so the count on screen is still the truth.
          current.map(label =>
            label.id === labelId ? { ...updated, taskCount: label.taskCount } : label
          )
        )
      );
      return updated;
    },
    [client, teamId]
  );

  const remove = useCallback(
    async (labelId: string) => {
      await client.deleteTaskLabel({ teamId, labelId });
      setLabels(current => current.filter(label => label.id !== labelId));
    },
    [client, teamId]
  );

  return { labels, loading, error, refetch, create, update, remove };
}
