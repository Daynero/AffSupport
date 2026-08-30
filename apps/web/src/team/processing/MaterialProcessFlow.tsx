import { useEffect, useRef, useState } from 'react';
import type { TeamAnalyticsStage, TeamProcessStartResult } from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { startTeamAgentProcess } from '../../api/client';
import { teamApi, type TeamProcessStartInput } from '../../api/team';
import {
  completeTeamWorkflow,
  startTeamWorkflow,
  type TeamWorkflowFlow
} from '../../analytics/service';
import { Button } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { teamErrorMessage } from '../errors';
import { OperationStatus } from './OperationStatus';
import { ProcessMaterialDialog, type ProcessableMaterial } from './ProcessMaterialDialog';
import { useTeamOperation } from './useTeamOperation';

/**
 * "Process" from a row, start to finish: the tool dialog, the local run on
 * the paired agent, the operation's progress until it settles. The catalog
 * and the explorer share it (011, findings K2 — the explorer's menu had the
 * button and nothing behind it).
 */
export function MaterialProcessFlow({
  teamId,
  material,
  destinationFolderId,
  browseClient,
  onClose,
  initialTool,
  onProgress
}: {
  teamId: string;
  material: ProcessableMaterial;
  destinationFolderId: string | null;
  browseClient: FolderPickerClient;
  onClose: () => void;
  initialTool?: 'compressor' | 'transcription' | 'imageEmbedding' | 'landingOptimizer';
  /** Live progress of the running operation, for a caller that mirrors it. */
  onProgress?: (info: { progress: number; state: string }) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const agent = useOptionalAgent();
  const [operation, setOperation] = useState<{
    id: string;
    workflow: TeamWorkflowFlow;
    failureCode: string | null;
  } | null>(null);
  // Cancelling aborts the agent's still-running request, which then rejects.
  // That rejection is expected — the overlay already shows "canceled" — so it
  // must not surface as an error toast. Remember which operations the person
  // cancelled and swallow only their rejection.
  const canceledOps = useRef<Set<string>>(new Set());

  const start = (result: TeamProcessStartResult, input: TeamProcessStartInput) => {
    const workflow = startTeamWorkflow({
      category: material.category ?? 'other',
      cacheState: 'unknown',
      attemptNumber: 1,
      stage: 'downloading'
    });
    setOperation({ id: result.operationId, workflow, failureCode: null });
    void startTeamAgentProcess({
      operationId: result.operationId,
      toolId: input.toolId,
      options: {},
      sourceGrant: result.sourceGrant,
      finalizeGrant: result.finalizeGrant
    }).catch(async (cause: unknown) => {
      // A rejection from an operation the person cancelled is not a failure.
      if (canceledOps.current.has(result.operationId)) {
        canceledOps.current.delete(result.operationId);
        return;
      }
      const code = cause instanceof Error ? cause.message : 'PROCESS_FAILED';
      setOperation(current =>
        current && current.id === result.operationId ? { ...current, failureCode: code } : current
      );
      push({ tone: 'error', text: teamErrorMessage(code, t) });
      await teamApi.cancelOperation(teamId, result.operationId).catch(() => undefined);
    });
  };

  if (operation) {
    return (
      <ActiveOperation
        teamId={teamId}
        operationId={operation.id}
        workflow={operation.workflow}
        localFailureCode={operation.failureCode}
        agentEnabled={agent?.teamWorkspaceAvailable === true}
        onClose={onClose}
        onRetry={() => setOperation(null)}
        onCancelIntent={() => canceledOps.current.add(operation.id)}
        onProgress={onProgress}
      />
    );
  }
  return (
    <ProcessMaterialDialog
      teamId={teamId}
      material={material}
      destinationFolderId={destinationFolderId}
      browseClient={browseClient}
      agentCompatible={agent?.teamWorkspaceAvailable === true}
      toolContracts={agent?.toolContracts ?? {}}
      onClose={onClose}
      onStarted={start}
      initialTool={initialTool}
    />
  );
}

export function ActiveOperation({
  teamId,
  operationId,
  workflow,
  agentEnabled,
  localFailureCode = null,
  onClose,
  onRetry,
  onCancelIntent,
  onProgress
}: {
  teamId: string;
  operationId: string;
  workflow: TeamWorkflowFlow;
  agentEnabled: boolean;
  localFailureCode?: string | null;
  onClose: () => void;
  onRetry: () => void;
  /** Marks the run cancelled before aborting, so its rejection stays quiet. */
  onCancelIntent?: () => void;
  /** Reports live progress so a caller (e.g. the side card) can mirror it. */
  onProgress?: (info: { progress: number; state: string }) => void;
}) {
  const { t } = useI18n();
  const state = useTeamOperation({ teamId, operationId, agentEnabled });
  useEffect(() => {
    const operation = state.operation;
    if (!operation || !['succeeded', 'failed', 'canceled'].includes(operation.state)) return;
    completeTeamWorkflow(workflow, {
      outcome:
        operation.state === 'succeeded'
          ? 'success'
          : operation.state === 'canceled'
            ? 'cancelled'
            : 'failure',
      retryable: operation.retryable,
      stage: operationStage(operation.stage)
    });
  }, [state.operation, workflow]);
  useEffect(() => {
    const operation = state.operation;
    if (!operation || !onProgress) return;
    const running = operation.state === 'pending' || operation.state === 'running';
    const progress = Math.max(operation.progress, running ? (state.localProgress?.progress ?? 0) : 0);
    onProgress({ progress, state: operation.state });
  }, [state.operation, state.localProgress, onProgress]);
  if (!state.operation) return <p aria-live="polite">{t('teamOperationLoading')}</p>;
  return (
    <div className="team-operation-overlay">
      <OperationStatus
        operation={state.operation}
        localProgress={state.localProgress}
        localFailureCode={localFailureCode}
        onCancel={async () => {
          onCancelIntent?.();
          await state.cancel();
        }}
        onRetry={onRetry}
      />
      {(localFailureCode !== null || !['pending', 'running'].includes(state.operation.state)) && (
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamOperationClose')}
        </Button>
      )}
    </div>
  );
}

export function operationStage(stage: string | null): TeamAnalyticsStage {
  return ['finding', 'previewing', 'downloading', 'processing', 'uploading', 'finalizing'].includes(
    stage ?? ''
  )
    ? (stage as TeamAnalyticsStage)
    : 'processing';
}
