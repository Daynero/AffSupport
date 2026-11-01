import type { LaunchGeneration, LaunchStage } from '@video-compressor/shared';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { CircleAlert, Clock3 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Alert, Button, Card, StageProgress } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { useTeamOperation } from '../processing/useTeamOperation';
import { useOptionalTeam } from '../TeamContext';
import { teamErrorMessage } from '../errors';
import {
  launchProgressStages,
  launchProgressDisplayStage,
  launchStageLabels,
  newLaunchProgressMemory,
  rememberLaunchProgress
} from './progress';
import { restitchSettingsError, restitchMediaError } from './recovery';
import { useLaunchElapsed } from './useLaunchElapsed';
import { useLaunchProgressWatch } from './useLaunchProgressWatch';

export function LaunchGenerationProgress({
  generation,
  onCancel,
  onFailedRestitch,
  disabled,
  teamId,
  method = 'catalog',
  restitchEnabled = Boolean(
    generation?.restitchOperationId || generation?.stage.startsWith('restitch_')
  ),
  pendingStage,
  requestError,
  onRefresh,
  onOpenRestitchSettings,
  onUseOriginalVideo,
  launchId,
  requestErrorCode,
  retryActions
}: {
  onOpenRestitchSettings?: () => void;
  onUseOriginalVideo?: () => void;
  launchId?: string;
  requestErrorCode?: string | null;
  retryActions?: ReactNode;
  generation: LaunchGeneration | null;
  onCancel: () => void;
  onFailedRestitch?: (operationId: string | null) => void;
  disabled: boolean;
  teamId?: string;
  method?: 'catalog' | 'other';
  restitchEnabled?: boolean;
  pendingStage?: LaunchStage | null;
  requestError?: string | null;
  onRefresh?: (signal: AbortSignal) => Promise<void>;
}) {
  const { t } = useI18n();
  const workspace = useOptionalTeam();
  const observingRestitch = !pendingStage && generation?.state === 'waiting_dependency';
  const child = useTeamOperation({
    teamId: teamId ?? '',
    operationId: observingRestitch && teamId ? (generation.restitchOperationId ?? null) : null,
    workspaceObservation: true,
    workflowId: generation?.id
  });
  const current = pendingStage ? null : generation;
  const requestedStage = pendingStage ?? current?.stage ?? 'validation';
  const cancelling =
    pendingStage === 'cancel' ||
    current?.state === 'cancel_requested' ||
    current?.state === 'canceled_with_cleanup_pending';
  const cleanupPending = current?.state === 'canceled_with_cleanup_pending';
  const terminal =
    current &&
    ['failed', 'partial', 'interrupted', 'succeeded', 'canceled'].includes(current.state);
  const childState =
    child.operation && !['running', 'pending'].includes(child.operation.state)
      ? child.operation.state
      : (child.localState ?? child.operation?.state);
  const childFailed = observingRestitch && (childState === 'failed' || childState === 'canceled');
  const childSucceeded = observingRestitch && childState === 'succeeded';
  const stage = launchProgressDisplayStage({
    generation: current,
    stage: requestedStage,
    restitch: restitchEnabled,
    childSucceeded
  });
  const reconciling = Boolean(
    current &&
    ['accepted', 'running', 'waiting_dependency'].includes(current.state) &&
    requestError &&
    requestErrorCode &&
    ['LEASE_MISMATCH', 'LEASE_EXPIRED', 'LAUNCH_BUSY', 'LAUNCH_RESULT_UNCERTAIN'].includes(
      requestErrorCode
    )
  );
  const failedChildId =
    childFailed && !child.streamDisconnected ? (generation?.restitchOperationId ?? null) : null;
  useEffect(() => {
    onFailedRestitch?.(failedChildId);
    return () => onFailedRestitch?.(null);
  }, [failedChildId, onFailedRestitch]);
  const code =
    (reconciling ? null : requestErrorCode) ??
    current?.errorCode ??
    (childFailed
      ? (child.localErrorCode ??
        child.operation?.errorCode ??
        (childState === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED'))
      : null);
  const needsAttention = Boolean(
    code ||
    (!reconciling && requestError) ||
    childFailed ||
    (terminal && current?.state !== 'succeeded' && current?.state !== 'canceled')
  );
  const disconnected =
    (observingRestitch && Boolean(child.streamDisconnected || child.error)) ||
    Boolean(
      workspace?.realtimeConnectionState &&
      ['connecting', 'reconnecting'].includes(workspace.realtimeConnectionState)
    );
  const evidence = JSON.stringify([
    current?.id,
    current?.stateVersion,
    current?.state,
    stage,
    current?.progress,
    current?.steps,
    child.operation?.id,
    child.operation?.state,
    child.operation?.stage,
    child.operation?.progress,
    child.operation?.updatedAt,
    child.localProgress?.stage,
    child.localProgress?.progress,
    childState
  ]);
  const watching = !terminal && (cancelling || !needsAttention);
  const refreshChild = child.refetch;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      await Promise.all([onRefresh?.(signal), observingRestitch ? refreshChild?.() : undefined]);
    },
    [onRefresh, observingRestitch, refreshChild]
  );
  const watch = useLaunchProgressWatch(watching, evidence, refresh);
  const uncertain = disconnected || watch.readFailed;
  const elapsedLabel = useLaunchElapsed(
    `${teamId ?? ''}:${launchId ?? 'new'}`,
    generation,
    Boolean(pendingStage && pendingStage !== 'cancel'),
    watching
  );
  const localLabels: Record<string, TranslationKey> = {
    downloading: 'teamOperationDownloading',
    processing: 'launchesStageRestitchProcessing',
    uploading: 'launchesStageRestitchUploading',
    finalizing: 'teamOperationFinalizing'
  };
  const childStage = !child.streamDisconnected
    ? (child.localProgress?.stage ?? child.operation?.stage)
    : child.operation?.stage;
  const action = childSucceeded
    ? t('launchesProgressVideoReady')
    : t(
        observingRestitch && childStage
          ? (localLabels[childStage] ?? launchStageLabels[stage] ?? 'launchesStageUnknown')
          : (launchStageLabels[stage] ?? 'launchesStageUnknown')
      );
  const measured = current?.progress;
  const validMeasured =
    stage === requestedStage &&
    !observingRestitch &&
    measured &&
    Number.isFinite(measured.completed) &&
    Number.isFinite(measured.total) &&
    measured.total > 0 &&
    measured.completed >= 0 &&
    measured.completed <= measured.total;
  const childPercent = child.localProgress?.progress ?? child.operation?.progress;
  const validChild =
    observingRestitch &&
    !childSucceeded &&
    typeof childPercent === 'number' &&
    Number.isFinite(childPercent) &&
    childPercent >= 0 &&
    childPercent <= 100;
  const videoPhase = ['downloading', 'processing', 'uploading', 'finalizing'].indexOf(
    childStage ?? ''
  );
  // Encoding 100% is not video delivery: upload and finalization still follow.
  const fraction =
    validChild && videoPhase >= 0
      ? (videoPhase + childPercent / 100) / 4
      : validMeasured
        ? measured.completed / measured.total
        : undefined;
  const observedStages = launchProgressStages(
    {
      generation: current,
      stage,
      method,
      restitch: restitchEnabled,
      childSucceeded,
      // A stale observation does not undo completed work or turn it into a failure.
      attention: needsAttention || cancelling || uncertain,
      fraction
    },
    t
  );
  const progressMemory = useRef(newLaunchProgressMemory());
  const stages = rememberLaunchProgress(progressMemory.current, {
    scope: `${teamId ?? ''}:${current?.id ?? 'pending'}`,
    generation: current,
    stage,
    stages: observedStages,
    attention: needsAttention || cancelling || uncertain
  });
  const confirmedAction =
    progressMemory.current.stage && progressMemory.current.stage !== stage && current
      ? t(launchStageLabels[progressMemory.current.stage] ?? 'launchesStageUnknown')
      : action;
  const statusLabel = cancelling
    ? t(cleanupPending ? 'launchesStageCleanup' : 'launchesStageCancel')
    : uncertain || needsAttention
      ? t('launchesProgressLastConfirmed', { stage: confirmedAction })
      : confirmedAction;
  const currentIndex = stages.findIndex(
    entry => entry.state === 'active' || entry.state === 'attention'
  );
  const count =
    currentIndex >= 0
      ? t('productCatalogStageOf', { step: currentIndex + 1, total: stages.length })
      : undefined;
  const detail =
    !uncertain && !needsAttention && !cancelling
      ? validMeasured
        ? `${measured.completed} / ${measured.total} ${measured.unit}`
        : validChild
          ? `${Math.round(childPercent)}%`
          : count
      : count;
  const failed = Boolean(
    childFailed || (current && ['failed', 'partial', 'interrupted'].includes(current.state))
  );
  const showError =
    !cancelling &&
    needsAttention &&
    current?.state !== 'succeeded' &&
    current?.state !== 'canceled';
  const unconfirmed =
    showError && !failed && Boolean(requestError || code === 'LAUNCH_RESULT_UNCERTAIN');
  const showNotice =
    cleanupPending || reconciling || (!showError && uncertain) || Boolean(current?.stepsTruncated);
  return (
    <Card
      role="section"
      className={`launch-generation-progress${showError ? ' is-error' : uncertain ? ' is-unconfirmed' : ''}`}
      title={t('launchesProgressTitle')}
      aside={
        elapsedLabel && (
          <span
            className="inline-flex items-center gap-2 rounded-control bg-surface px-3 py-2 text-caption text-muted tabular-nums"
            aria-label={t('launchesProgressElapsed', { time: elapsedLabel })}
          >
            <Clock3 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{elapsedLabel}</span>
          </span>
        )
      }
    >
      {showError && (
        <Alert
          color="error"
          live="alert"
          icon={<CircleAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          title={t(
            failed
              ? 'launchesProgressStopped'
              : unconfirmed
                ? 'launchesProgressErrorUnconfirmed'
                : 'launchesProgressActionRequired'
          )}
        >
          {(!reconciling && requestError) ||
            (code ? teamErrorMessage(code, t) : t('launchesProgressActionRequired'))}
          {unconfirmed && (
            <span className="launch-progress-error-hint">
              {t('launchesProgressUnconfirmedHint')}
            </span>
          )}
        </Alert>
      )}
      <StageProgress
        captionBelow
        stages={stages}
        label={statusLabel}
        detail={detail ?? '\u00a0'}
        active={watching && !cancelling && !uncertain}
        stepsLabel={t('launchesSteps')}
      />
      {showNotice && (
        <div className="launch-progress-notice">
          {reconciling && !showError ? (
            <p role="status">{t('launchesProgressReconciling')}</p>
          ) : cleanupPending ? (
            <p role="status">{t('launchesCleanupPending')}</p>
          ) : uncertain && !showError ? (
            <Alert color="warning" title={t('launchesProgressUnconfirmed')}>
              {t(
                watch.readFailed
                  ? 'launchesProgressRefreshFailed'
                  : disconnected
                    ? 'launchesProgressConnectionLost'
                    : 'launchesProgressWaiting'
              )}
            </Alert>
          ) : null}
          {current?.stepsTruncated && <p>{t('launchesStepsTruncated')}</p>}
        </div>
      )}
      {showError && restitchEnabled && restitchMediaError(code) && onUseOriginalVideo && (
        <div className="flex flex-col items-start gap-3 rounded-control bg-surface p-3">
          <p className="m-0 text-caption text-muted">{t('launchesOriginalVideoHint')}</p>
          <Button disabled={disabled} onClick={onUseOriginalVideo}>
            {t('launchesUseOriginalVideo')}
          </Button>
        </div>
      )}
      <div className="launch-progress-actions flex flex-wrap items-center gap-2">
        {onOpenRestitchSettings && restitchSettingsError(code) && (
          <Button onClick={onOpenRestitchSettings}>{t('launchesOpenRestitchSettings')}</Button>
        )}
        {!cancelling && current?.state !== 'succeeded' && current?.state !== 'canceled' && (
          <Button disabled={disabled} onClick={onCancel}>
            {t('launchesCancel')}
          </Button>
        )}
        {(needsAttention || uncertain || terminal) && retryActions}
      </div>
    </Card>
  );
}
