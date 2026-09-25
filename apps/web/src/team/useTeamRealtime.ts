import { realtimeTopic } from '../lib/realtimeTopic';
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient } from '../lib/supabase';

export type TeamRealtimeState = 'disabled' | 'connecting' | 'connected' | 'reconnecting';

export function useTeamRealtime(input: {
  teamId: string | null;
  onRefetch: () => void | Promise<void>;
  enabled?: boolean;
  retryNonce?: number;
}): TeamRealtimeState {
  const { teamId, onRefetch, enabled = true, retryNonce = 0 } = input;
  const [state, setState] = useState<TeamRealtimeState>(
    enabled && teamId ? 'connecting' : 'disabled'
  );
  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!enabled || !supabase || !teamId) {
      setState('disabled');
      return;
    }

    let active = true;
    let subscribed = false;
    let dirty = false;
    let refreshing = false;
    let failedReads = 0;
    let refetchTimer: number | null = null;
    const flush = async () => {
      refetchTimer = null;
      if (!active || refreshing || !dirty) return;
      dirty = false;
      refreshing = true;
      try {
        await onRefetch();
        if (!active) return;
        failedReads = 0;
        if (subscribed) setState('connected');
      } catch {
        if (!active) return;
        failedReads += 1;
        if (failedReads <= 2) dirty = true;
        setState('reconnecting');
      } finally {
        refreshing = false;
        // A change delivered during the read must get a later authoritative
        // snapshot; event IDs are not contiguous replay positions.
        if (dirty) schedule();
      }
    };
    const schedule = () => {
      if (!active || refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => void flush(), 1_000);
    };
    const refetch = () => {
      if (!active) return;
      dirty = true;
      if (!refreshing) schedule();
    };
    const channel: RealtimeChannel = supabase
      .channel(realtimeTopic(`team-workspace:${teamId}`))
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_operations', filter: `team_id=eq.${teamId}` },
        refetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_catalog_events',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .subscribe(status => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          refetch();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          subscribed = false;
          setState('reconnecting');
        } else if (status === 'CLOSED') {
          subscribed = false;
          setState('reconnecting');
        }
      });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    setState('connecting');
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (refetchTimer !== null) {
        window.clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [enabled, onRefetch, retryNonce, teamId]);

  return state;
}
