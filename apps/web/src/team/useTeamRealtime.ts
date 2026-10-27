import { memberAttempt } from './members/diagnostics';
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
    let urgentDirty = false;
    let membershipDirty = false;
    let membershipFlowId: string | null = null;
    let refreshing = false;
    let failedReads = 0;
    let refetchTimer: number | null = null;
    const flush = async () => {
      refetchTimer = null;
      if (!active || refreshing || !dirty) return;
      dirty = false;
      urgentDirty = false;
      refreshing = true;
      const attempt = membershipDirty
        ? memberAttempt('member_access_refresh', membershipFlowId ?? crypto.randomUUID())
        : null;
      membershipDirty = false;
      try {
        await onRefetch();
        if (!active) return;
        attempt?.finish('success');
        if (!membershipDirty) membershipFlowId = null;
        failedReads = 0;
        if (subscribed) setState('connected');
      } catch (cause) {
        if (!active) return;
        attempt?.finish('failure', cause);
        failedReads += 1;
        if (failedReads <= 2) {
          dirty = true;
          if (attempt) membershipDirty = true;
        }
        setState('reconnecting');
      } finally {
        refreshing = false;
        // A change delivered during the read must get a later authoritative
        // snapshot; event IDs are not contiguous replay positions.
        if (dirty) schedule(urgentDirty);
      }
    };
    const schedule = (urgent = false) => {
      if (urgent && refetchTimer !== null) {
        window.clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      if (!active || refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => void flush(), urgent ? 0 : 1_000);
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
          event: 'INSERT',
          schema: 'public',
          table: 'team_catalog_events',
          // Invalidation signals are append-only; retention deletes are not
          // changes to the user's catalog and must not trigger another read.
          filter: `team_id=eq.${teamId}`
        },
        payload => {
          if (
            payload?.new &&
            'event_kind' in payload.new &&
            payload.new.event_kind === 'bulk_trash_changed'
          ) {
            dirty = true;
            urgentDirty = true;
            if (!refreshing) schedule(true);
          } else refetch();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_catalog_image_imports',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_launch_signals',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_launch_workspace_signals',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_account_workspace_signals',
          filter: `team_id=eq.${teamId}`
        },
        refetch
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_membership_access_signals',
          filter: `team_id=eq.${teamId}`
        },
        () => {
          if (!active) return;
          membershipFlowId ??= crypto.randomUUID();
          membershipDirty = true;
          dirty = true;
          urgentDirty = true;
          if (!refreshing) schedule(true);
        }
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
