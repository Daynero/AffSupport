import { realtimeTopic } from '../lib/realtimeTopic';
import { useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient } from '../lib/supabase';

export type TeamRealtimeState = 'disabled' | 'connecting' | 'connected' | 'reconnecting';

function rowFromPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function useTeamRealtime(input: {
  teamId: string | null;
  onRefetch: () => void | Promise<void>;
  onMembershipLost: () => void;
  enabled?: boolean;
}): TeamRealtimeState {
  const { teamId, onRefetch, onMembershipLost, enabled = true } = input;
  const [state, setState] = useState<TeamRealtimeState>(
    enabled && teamId ? 'connecting' : 'disabled'
  );
  const refetchTimer = useRef<number | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!enabled || !supabase || !teamId) {
      setState('disabled');
      return;
    }

    let active = true;
    let connectedOnce = false;
    let userId: string | null = null;
    void supabase.auth.getUser().then(({ data }) => {
      if (active) userId = data.user?.id ?? null;
    });

    const refetch = () => {
      if (!active || refetchTimer.current !== null) return;
      // Indexing emits progress rows frequently. One workspace refresh per window is enough;
      // otherwise every page causes all navigation panels to re-read the full folder tree.
      refetchTimer.current = window.setTimeout(() => {
        refetchTimer.current = null;
        if (active) void onRefetch();
      }, 1_000);
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
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_drive_connections',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_members', filter: `team_id=eq.${teamId}` },
        payload => {
          const row = rowFromPayload(payload.new) ?? rowFromPayload(payload.old);
          if (
            row?.user_id === userId &&
            (payload.eventType === 'DELETE' || row.status !== 'active')
          ) {
            active = false;
            onMembershipLost();
            void supabase.removeChannel(channel);
            return;
          }
          refetch();
        }
      )
      .subscribe(status => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          setState('connected');
          if (connectedOnce) refetch();
          connectedOnce = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setState('reconnecting');
        } else if (status === 'CLOSED') {
          setState('reconnecting');
        }
      });

    setState('connecting');
    return () => {
      active = false;
      if (refetchTimer.current !== null) {
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [enabled, onMembershipLost, onRefetch, teamId]);

  return state;
}
