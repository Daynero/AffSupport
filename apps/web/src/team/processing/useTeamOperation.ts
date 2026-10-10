import { realtimeTopic } from '../../lib/realtimeTopic';
import { useCallback, useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { TeamOperationSnapshot } from '../../api/team';
import { teamApi } from '../../api/team';
import { cancelTeamAgentProcess, toolEventUrl } from '../../api/client';
import { useOptionalAgent } from '../../AgentContext';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { getSupabaseClient } from '../../lib/supabase';
import type { LocalTeamProgress } from './OperationStatus';
import { teamOperationErrorStage, trackToolError } from '../../analytics/errors';

/**
 * Operations whose failure was already reported. Two surfaces can watch the same operation
 * (the process flow and the queue), and a failure is one event however many people looked.
 */
const reportedFailures = new Set<string>();
const REPORTED_FAILURES_MAX = 200;

/** `error_occurred` once per failed operation, with the server's code and the operation id. */
export function reportTeamOperationFailure(
  operation: TeamOperationSnapshot,
  workflowId?: string
): void {
  if (operation.state !== 'failed' || reportedFailures.has(operation.id)) return;
  if (reportedFailures.size >= REPORTED_FAILURES_MAX) reportedFailures.clear();
  reportedFailures.add(operation.id);
  trackToolError({
    tool: 'team',
    stage: teamOperationErrorStage(operation.kind),
    code: operation.errorCode,
    flowId: operation.id,
    ...(workflowId ? { workflowId } : {}),
    retryable: operation.retryable
  });
}

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
  /** The analytics workflow this operation belongs to, so its failure correlates (031). */
  workflowId?: string;
}) {
  const { teamId, operationId, agentEnabled = true, client = teamApi, workflowId } = input;
  const [operation, setOperation] = useState<TeamOperationSnapshot | null>(null);
  const [localProgress, setLocalProgress] = useState<LocalTeamProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!operationId) return;
    try {
      const value = await client.getOperation(teamId, operationId);
      setOperation(value);
      setError(null);
      reportTeamOperationFailure(value, workflowId);
      if (!['pending', 'running'].includes(value.state)) setLocalProgress(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'INVALID_RESPONSE');
    }
  }, [client, operationId, teamId, workflowId]);

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
      .channel(realtimeTopic(`team-operation:${operationId}`))
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
