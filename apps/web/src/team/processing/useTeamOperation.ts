import { useCallback, useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { TeamOperationSnapshot } from '../../api/team';
import { teamApi } from '../../api/team';
import { cancelTeamAgentProcess, toolEventUrl } from '../../api/client';
import { useOptionalAgent } from '../../AgentContext';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { getSupabaseClient } from '../../lib/supabase';
import type { LocalTeamProgress } from './OperationStatus';

interface TeamOperationSseEvent {
  type: 'team:operations';
  operations: Array<{
    operationId: string;
    state: 'running' | 'succeeded' | 'failed' | 'canceled';
    stage: string;
    progress: number;
    errorCode: string | null;
    updatedAt: string;
  }>;
}

export function useTeamOperation(input: {
  teamId: string;
  operationId: string | null;
  agentEnabled?: boolean;
  client?: Pick<typeof teamApi, 'getOperation' | 'cancelOperation'>;
}) {
  const { teamId, operationId, agentEnabled = true, client = teamApi } = input;
  const [operation, setOperation] = useState<TeamOperationSnapshot | null>(null);
  const [localProgress, setLocalProgress] = useState<LocalTeamProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!operationId) return;
    try {
      const value = await client.getOperation(teamId, operationId);
      setOperation(value);
      setError(null);
      if (!['pending', 'running'].includes(value.state)) setLocalProgress(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'INVALID_RESPONSE');
    }
  }, [client, operationId, teamId]);

  useEffect(() => {
    setOperation(null);
    setLocalProgress(null);
    setError(null);
    if (operationId) void refetch();
  }, [operationId, refetch]);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase || !operationId) return;
    const channel: RealtimeChannel = supabase
      .channel(`team-operation:${operationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'team_operations',
          filter: `id=eq.${operationId}`
        },
        () => void refetch()
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') void refetch();
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [operationId, refetch]);

  const agent = useOptionalAgent();
  const multiplexed = Boolean(agent?.capabilities?.includes('event-stream'));

  useAgentEventStream<TeamOperationSseEvent>({
    url: operationId && agentEnabled ? toolEventUrl('team') : null,
    channel: 'team',
    multiplexed,
    enabled: Boolean(operationId && agentEnabled),
    onMessage: event => {
      if (event.type !== 'team:operations' || !operationId) return;
      const local = event.operations.find(item => item.operationId === operationId);
      if (!local) return;
      setLocalProgress({ stage: local.stage, progress: local.progress });
      if (local.state !== 'running') void refetch();
    }
  });

  const cancel = useCallback(async () => {
    if (!operationId) return;
    await Promise.allSettled([
      agentEnabled ? cancelTeamAgentProcess(operationId) : Promise.resolve(false),
      client.cancelOperation(teamId, operationId)
    ]);
    await refetch();
  }, [agentEnabled, client, operationId, refetch, teamId]);

  return { operation, localProgress, error, refetch, cancel };
}
