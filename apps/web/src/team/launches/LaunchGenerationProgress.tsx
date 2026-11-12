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
import { useSustained } from '../../lib/useSustained';

/**
 * Codes with which the server's recovery pass picks an interrupted catalog launch up again by
 * itself, thirty seconds later (service_list_launch_catalog_recovery). Such an interruption is a pause in
 * the run, not its end: 1.4.3 said "Generation stopped" while the server went on to finish it.
 */
const RECOVERED_INTERRUPTIONS = new Set([
  'DRIVE_UNAVAILABLE',
  'RATE_LIMITED',
  'LAUNCH_INTERNAL_ERROR',
  'LAUNCH_RESULT_UNCERTAIN',
  'GROUP_RECONCILING',
  'LEASE_MISMATCH',
  'UNKNOWN',
  'PROCESS_RESULT_UNCERTAIN'
]);

export function LaunchGenerationProgress({
  generation,
  onCancel,
  onFailedRestitch,
  disabled,
  teamId,
  method = 'catalog',
  restitchEnabled = Boolean(
    generation?.videoGeneration ||
    generation?.restitchOperationId ||
    generation?.stage.startsWith('restitch_')
  ),
  pendingStage,
  requestError,
  onRefresh,
  onOpenRestitchSettings,
  onUseOriginalVideo,
  launchId,
  requestErrorCode,
  requestErrorDefinitive = false,
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
  /** The server refused the request outright; no generation is running. */
  requestErrorDefinitive?: boolean;
  onRefresh?: (signal: AbortSignal) => Promise<void>;
}) {
  const { t } = useI18n();
  const activeRestitch = Boolean(generation?.videoGeneration) || restitchEnabled;
  const workspace = useOptionalTeam();
  const observingRestitch = !pendingStage && generation?.state === 'waiting_dependency';
  const child = useTeamOperation({
    teamId: teamId ?? '',
    operationId: observingRestitch && teamId ? (generation.restitchOperationId ?? null) : null,
    workspaceObservation: true,
    workflowId: generation?.id
  });
  const retainedVideoInterruption = Boolean(
    generation?.videoGeneration?.state === 'unknown' &&
    ['failed', 'partial', 'interrupted'].includes(generation.state)
  );
  const canonicalCancellationPending = Boolean(
    generation &&
    (['cancel_requested', 'canceled_with_cleanup_pending'].includes(generation.state) ||
      generation.videoGeneration?.state === 'cancel_requested')
  );
  const retainCanonicalStatus = retainedVideoInterruption || canonicalCancellationPending;
  const current = pendingStage && !retainCanonicalStatus ? null : generation;
  const videoGeneration = current?.videoGeneration;
  const videoPending = Boolean(
    videoGeneration &&
    ['accepted', 'preparing', 'cancel_requested', 'unknown'].includes(videoGeneration.state)
  );
  const requestedStage = retainCanonicalStatus
    ? generation!.stage
    : (pendingStage ?? current?.stage ?? 'validation');
  const cancelling =
    pendingStage === 'cancel' ||
    videoGeneration?.state === 'cancel_requested' ||
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
  // An interrupted catalog run whose video result is not settled yet is picked
  // up again on its own: the agent resumes or the server takes the variant over,
  // and the launch recovery carries on (1.4.3). It used to say «Генерацію
  // зупинено» with «Повторити» while the run finished 5 of 5 seven minutes later.
  const recovering = Boolean(
    method === 'catalog' &&
    current?.state === 'interrupted' &&
    !childFailed &&
    (!current.errorCode || RECOVERED_INTERRUPTIONS.has(current.errorCode))
  );
  const checkingVideoResult = recovering && retainedVideoInterruption;
  // Retry is not offered while the run is still picking itself up; it returns
  // only if the recovery has not moved for a while.
  const recoveryStalled = useSustained(recovering, LAUNCH_RECOVERY_PATIENCE_MS);
  const stage = launchProgressDisplayStage({
    generation: current,
    stage: requestedStage,
    restitch: activeRestitch,
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
  const canonicalTerminalCause = Boolean(
    current &&
    ['failed', 'partial', 'interrupted'].includes(current.state) &&
    current.errorCode &&
    ![
      'UNKNOWN',
      'LAUNCH_BUSY',
      'LEASE_MISMATCH',
      'LEASE_EXPIRED',
      'LAUNCH_RESULT_UNCERTAIN',
      'PROCESS_RESULT_UNCERTAIN'
    ].includes(current.errorCode)
  );
  const code =
    (canonicalTerminalCause ? current?.errorCode : null) ??
    (reconciling ? null : requestErrorCode) ??
    current?.errorCode ??
    (childFailed
      ? (child.localErrorCode ??
        child.operation?.errorCode ??
        (childState === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED'))
      : null);
  const needsAttention =
    !recovering &&
    Boolean(
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
    videoGeneration,
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
  // A recovering run is watched like a running one, so its finish shows without a reload.
  const watching = videoPending || recovering || (!terminal && (cancelling || !needsAttention));
  const refreshChild = child.refetch;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      await Promise.all([onRefresh?.(signal), observingRestitch ? refreshChild?.() : undefined]);
    },
    [onRefresh, observingRestitch, refreshChild]
  );
  const watch = useLaunchProgressWatch(
    watching,
    evidence,
    refresh,
    canonicalCancellationPending && onRefresh ? `${teamId ?? ''}:${generation!.id}` : undefined
  );
  const lostTouch = disconnected || watch.readFailed;
  // A short outage clears by itself: keep the last confirmed state and say so calmly.
  // Only a sustained one asks the user to check and retry. A refused read gets the same
  // patience: it is retried with backoff, and a restarting agent used to make one look
  // final at once, «Статус не підтверджено» with «Повторити» (1.4.3 QA). Refusals that
  // end the session (permission, a vanished launch) close the dialog instead.
  const lostTouchLong = useSustained(lostTouch, LAUNCH_OUTAGE_PATIENCE_MS);
  const briefOutage = lostTouch && !lostTouchLong;
  const uncertain = lostTouch && !briefOutage;
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
      restitch: activeRestitch,
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
    : current?.state === 'canceled'
      ? t('teamAuditCanceled')
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
        ? measured.source === 'registered_video_variants'
          ? videoGeneration
            ? count
            : t('catalogVideoCreationProgress', {
                ready: measured.completed,
                total: measured.total
              })
          : `${measured.completed} / ${measured.total} ${measured.unit}`
        : validChild
          ? `${Math.round(childPercent)}%`
          : count
      : count;
  const failed = Boolean(
    childFailed ||
    (current && ['failed', 'partial', 'interrupted'].includes(current.state) && !recovering)
  );
  const showError =
    !cancelling &&
    needsAttention &&
    current?.state !== 'succeeded' &&
    current?.state !== 'canceled';
  // Refused before anything ran: say so plainly, no "may still be running", no clock.
  const notStarted = showError && !failed && requestErrorDefinitive && !current;
  const unconfirmed =
    showError &&
    !failed &&
    !notStarted &&
    code !== 'AGENT_REQUIRED' &&
    Boolean(requestError || code === 'LAUNCH_RESULT_UNCERTAIN');
  // Google refused even after the automatic repeats (production 2026-11-12). Repeat sends the
  // same request key, so it can never duplicate: say that, not «may still be running».
  const googleBusy = unconfirmed && (code === 'DRIVE_UNAVAILABLE' || code === 'RATE_LIMITED');
  const showNotice =
    recovering ||
    canonicalCancellationPending ||
    cleanupPending ||
    reconciling ||
    (!showError && (uncertain || briefOutage)) ||
    Boolean(current?.stepsTruncated);
  return (
    <Card
      role="section"
      className={`launch-generation-progress${showError ? ' is-error' : uncertain ? ' is-unconfirmed' : ''}`}
      title={t('launchesProgressTitle')}
      aside={
        elapsedLabel &&
        !notStarted && (
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
              : notStarted
                ? 'launchesProgressNotStarted'
                : googleBusy
                  ? 'launchesProgressGoogleBusy'
                  : unconfirmed
                    ? 'launchesProgressErrorUnconfirmed'
                    : 'launchesProgressActionRequired'
          )}
        >
          {(!canonicalTerminalCause && !reconciling && requestError) ||
            (code ? teamErrorMessage(code, t) : t('launchesProgressActionRequired'))}
          {unconfirmed && (
            <span className="launch-progress-error-hint">
              {t(googleBusy ? 'launchesProgressRetrySafe' : 'launchesProgressUnconfirmedHint')}
            </span>
          )}
        </Alert>
      )}
      <StageProgress
        captionBelow
        stages={stages}
        label={statusLabel}
        detail={detail ?? '\u00a0'}
        active={
          watching &&
          !cancelling &&
          !uncertain &&
          !needsAttention &&
          (videoGeneration?.state !== 'unknown' || checkingVideoResult)
        }
        stepsLabel={t('launchesSteps')}
      />
      {videoGeneration && (
        <p role="status" className="field-hint">
          {t('catalogVideoCreationProgress', {
            ready: videoGeneration.registeredCount,
            total: videoGeneration.requestedCount
          })}
          {videoGeneration.state === 'unknown'
            ? ` · ${t(checkingVideoResult ? 'catalogVideoCheckingResult' : 'catalogVideoCreationUnknown')}`
            : videoGeneration.state === 'cancel_requested'
              ? ` · ${t('catalogVideoCreationCanceling')}`
              : videoGeneration.state === 'canceled'
                ? ` · ${t('teamAuditCanceled')}`
                : ''}
        </p>
      )}
      {showNotice && (
        <div className="launch-progress-notice">
          {recovering && !uncertain ? (
            <p role="status">
              {t(
                checkingVideoResult
                  ? 'launchesProgressCheckingResult'
                  : 'launchesProgressRecovering'
              )}
            </p>
          ) : reconciling && !showError ? (
            <p role="status">{t('launchesProgressReconciling')}</p>
          ) : cleanupPending || canonicalCancellationPending ? (
            <p role="status">{t('launchesCleanupPending')}</p>
          ) : briefOutage && !showError ? (
            <p role="status" className="team-inline-note">
              {t('catalogVideoReadInterrupted')}
            </p>
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
      {showError && activeRestitch && restitchMediaError(code) && onUseOriginalVideo && (
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
        {!cancelling &&
          (current?.state !== 'succeeded' || videoPending) &&
          current?.state !== 'canceled' && (
            <Button disabled={disabled} onClick={onCancel}>
              {t(current?.state === 'succeeded' ? 'catalogVideoCancel' : 'launchesCancel')}
            </Button>
          )}
        {canonicalCancellationPending && onRefresh && (
          <Button disabled={watch.checking} onClick={() => void watch.refresh()}>
            {t(watch.checking ? 'launchesProgressChecking' : 'launchesProgressRefresh')}
          </Button>
        )}
        {!canonicalCancellationPending &&
          (!recovering || recoveryStalled) &&
          (needsAttention || uncertain || terminal) &&
          retryActions}
      </div>
    </Card>
  );
}

/** How long a lost connection may last before the user is asked to act. */
export const LAUNCH_OUTAGE_PATIENCE_MS = 30_000;

/** How long a run may pick itself up before Retry is offered as a way out. */
export const LAUNCH_RECOVERY_PATIENCE_MS = 3 * 60_000;
