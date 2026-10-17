import type { LaunchGeneration, LaunchStage } from '@video-compressor/shared';
import { useRef } from 'react';
import { Button, Card, StageProgress } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { useTeamOperation } from '../processing/useTeamOperation';
import { useOptionalTeam } from '../TeamContext';
import { teamErrorMessage } from '../errors';
import { launchProgressStages, launchStageLabels } from './progress';
import { restitchSettingsError } from './recovery';
import { useLaunchProgressWatch } from './useLaunchProgressWatch';

export function LaunchGenerationProgress({
  generation,
  onCancel,
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
  requestErrorCode
}: {
  onOpenRestitchSettings?: () => void;
  requestErrorCode?: string | null;
  generation: LaunchGeneration | null;
  onCancel: () => void;
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
  const stage = pendingStage ?? current?.stage ?? 'validation';
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
  const code =
    requestErrorCode ??
    current?.errorCode ??
    (childFailed
      ? (child.localErrorCode ??
        child.operation?.errorCode ??
        (childState === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED'))
      : null);
  const needsAttention = Boolean(
    code ||
    requestError ||
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
  const watching = !terminal && !cancelling && !needsAttention;
  const watch = useLaunchProgressWatch(watching, evidence, onRefresh);
  const uncertain = watch.quiet || disconnected || watch.readFailed;
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
  const statusLabel = cancelling
    ? t(cleanupPending ? 'launchesStageCleanup' : 'launchesStageCancel')
    : uncertain || needsAttention
      ? t('launchesProgressLastConfirmed', { stage: action })
      : action;
  const stages = launchProgressStages(
    {
      generation: current,
      stage,
      method,
      restitch: restitchEnabled,
      childSucceeded,
      // A stale observation does not undo completed work or turn it into a failure.
      attention: needsAttention || cancelling,
      fraction
    },
    t
  );
  const attempt = Math.max(0, ...(current?.steps?.map(step => step.attemptNo) ?? []));
  const fillScope = `${teamId ?? ''}:${current?.id ?? 'pending'}:${attempt}`;
  const confirmedFills = useRef({ scope: fillScope, values: new Map<string, number>() });
  if (confirmedFills.current.scope !== fillScope)
    confirmedFills.current = { scope: fillScope, values: new Map() };
  // Retain observed work through a missing/stale sample, but never carry it into
  // another generation or retry. This preserves evidence, not estimated time.
  for (const entry of stages) {
    if (entry.state === 'pending' || entry.state === 'complete') continue;
    const previous = confirmedFills.current.values.get(entry.id);
    if (entry.fraction !== undefined || previous !== undefined) {
      entry.fraction = Math.max(entry.fraction ?? 0, previous ?? 0);
      confirmedFills.current.values.set(entry.id, entry.fraction);
    }
  }
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
  const showNotice =
    cleanupPending || Boolean(requestError || code || uncertain || current?.stepsTruncated);
  return (
    <Card role="section" className="launch-generation-progress" title={t('launchesProgressTitle')}>
      <StageProgress
        captionBelow
        stages={stages}
        label={statusLabel}
        detail={detail ?? '\u00a0'}
        active={watching && !uncertain}
        stepsLabel={t('launchesSteps')}
      />
      {showNotice && (
        <div className="launch-progress-notice">
          {cleanupPending ? (
            <p role="status">{t('launchesCleanupPending')}</p>
          ) : requestError ? (
            <p role="alert">{requestError}</p>
          ) : code ? (
            <p role="alert">{teamErrorMessage(code, t)}</p>
          ) : uncertain ? (
            <p role="status">
              {t(
                watch.readFailed
                  ? 'launchesProgressRefreshFailed'
                  : disconnected
                    ? 'launchesProgressConnectionLost'
                    : 'launchesProgressWaiting'
              )}
            </p>
          ) : null}
          {current?.stepsTruncated && <p>{t('launchesStepsTruncated')}</p>}
        </div>
      )}
      <div className="launch-progress-actions flex flex-wrap items-center gap-2">
        {onOpenRestitchSettings && restitchSettingsError(code) && (
          <Button onClick={onOpenRestitchSettings}>{t('launchesOpenRestitchSettings')}</Button>
        )}
        {onRefresh && !terminal && (
          <Button variant="ghost" loading={watch.checking} onClick={() => void watch.refresh()}>
            {t('launchesProgressRefresh')}
          </Button>
        )}
        {!cancelling && current?.state !== 'succeeded' && current?.state !== 'canceled' && (
          <Button disabled={disabled} onClick={onCancel}>
            {t('launchesCancel')}
          </Button>
        )}
      </div>
    </Card>
  );
}
