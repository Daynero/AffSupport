import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Download, X } from 'lucide-react';
import type { NativeUpdateSnapshot, NativeUpdateStage } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { useI18n, type TranslationKey } from '../i18n';
import { installedReleaseStatus } from '../release-manifest';
import { useNativeAppUpdate } from '../updates/useNativeAppUpdate';
import { OPEN_NATIVE_APP_UPDATE } from '../updates/openNativeAppUpdate';
import { useOptionalUpdateCenter } from '../updates/UpdateCenter';
import { Button, IconButton, Modal, Switch } from './ui/index';
import { StageProgress, type ProgressStage } from './ui/StageProgress';
import { ICON_SIZE, ICON_STROKE } from './icons';
import { InstallerDownload } from './InstallerDownload';
import './native-app-update.css';

const DISMISSED_NATIVE_UPDATE = 'soty.native-update-dismissed.v1';
const ACTIVE: ReadonlySet<NativeUpdateStage> = new Set([
  'preparing',
  'consented',
  'draining',
  'drained',
  'install_committed',
  'replacement_started',
  'replacement_committed',
  'relaunch_requested',
  'target_started'
]);

function phaseFor(stage: NativeUpdateStage): number {
  if (['idle', 'offered', 'preparing', 'deferred', 'cancelled'].includes(stage)) return 0;
  return ['prepared', 'consented', 'draining', 'drained'].includes(stage) ? 1 : 2;
}

/** Explain the native receipt's closed reason, never infer failure from a lost link. */
function recoveryMessage(state: NativeUpdateSnapshot | null): TranslationKey {
  if (!state || state.stage === 'unknown' || state.stage === 'recovering')
    return 'appUpdateRecovery';
  switch (state.code) {
    case 'APP_UPDATE_DISK_FULL':
      return 'appUpdateDiskFull';
    case 'APP_UPDATE_DOWNLOAD_FAILED':
    case 'APP_UPDATE_DOWNLOAD_TIMEOUT':
      return 'appUpdateDownloadFailed';
    case 'APP_UPDATE_UNSAFE_INSTALLATION':
      return 'appUpdateMoveToApplications';
    case 'APP_UPDATE_PERMISSION_DENIED':
      return 'appUpdatePermissionDenied';
    case 'APP_UPDATE_FLUSH_FAILED':
      return 'appUpdateSaveFailed';
    case 'APP_UPDATE_BUSY':
      return 'appUpdateBusy';
    case 'APP_UPDATE_MANIFEST_INVALID':
    case 'APP_UPDATE_DIGEST_MISMATCH':
    case 'APP_UPDATE_IDENTITY_MISMATCH':
    case 'APP_UPDATE_WRONG_TARGET':
      return 'appUpdateVerificationFailed';
    case 'APP_UPDATE_CANDIDATE_CHANGED':
      return 'appUpdateCandidateChanged';
    case 'APP_UPDATE_READINESS_TIMEOUT':
    case 'APP_UPDATE_UI_UNCONFIRMED':
      return 'appUpdateReadiness';
    default:
      return 'appUpdateRetryHelp';
  }
}

export function NativeAppUpdateNotice({ fallback }: { fallback?: ReactNode }) {
  const agent = useAgent();
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnToWork = useRef(false);
  const [open, setOpen] = useState(false);
  // A check the person asked for that found nothing newer: say so, instead of leaving the
  // same «check for updates» line as if the press had done nothing (next QA 2026-11-17).
  const [checkedCurrent, setCheckedCurrent] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_NATIVE_UPDATE);
    } catch {
      return null;
    }
  });
  const supported = agent.capabilities.includes('native-app-updates-v1');
  // A live host can require a newer tool contract while its updater remains usable.
  const connected =
    agent.connection === 'connected' || agent.connection === 'agent_update_required';
  // 074: under the update center the page has one reader of the updater, and the
  // header button carries the offer; this keeps only the details dialog and the
  // fallbacks. Alone (a test, a page without the center) it reads for itself.
  const center = useOptionalUpdateCenter();
  const own = useNativeAppUpdate(supported && !center, connected, agent.agentBuildId);
  const { state, error, pending, act, refresh } = center?.native ?? own;
  const recovery = agent.agentRuntime?.nativeAppUpdateStatus === 'recovery_required';
  const completedAttempt =
    state?.nativeSuccess && state.attemptId ? `${state.installationId}:${state.attemptId}` : null;
  useEffect(() => {
    if (!open && returnToWork.current) {
      returnToWork.current = false;
      if (document.activeElement === document.body) {
        document
          .querySelector<HTMLElement>(
            'main button:not(:disabled), main a[href], header button:not(:disabled)'
          )
          ?.focus({ preventScroll: true });
      }
    }
  }, [open, dismissed]);
  useEffect(() => {
    const show = () => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      setCheckedCurrent(false);
      void refresh();
    };
    window.addEventListener(OPEN_NATIVE_APP_UPDATE, show);
    return () => window.removeEventListener(OPEN_NATIVE_APP_UPDATE, show);
  }, [refresh]);
  if (
    !open &&
    !recovery &&
    !error &&
    (!state ||
      ['idle', 'cancelled'].includes(state.stage) ||
      (completedAttempt !== null && completedAttempt === dismissed))
  ) {
    const manifest =
      agent.releaseManifest.status === 'ready' ? agent.releaseManifest.manifest : null;
    const target = agent.agentRuntime?.packageTarget;
    const missing =
      (target === 'macos-arm64' || target === 'macos-x64') &&
      manifest &&
      !manifest.nativeUpdates?.[target];
    const rollback =
      installedReleaseStatus({
        manifest,
        installedVersion: agent.agentVersion,
        installedChannel: agent.agentChannel,
        compatible: agent.toolAvailable('compressor')
      }) === 'newer';
    // The signed-channel notice owns intentional rollback and its tester exclusion.
    return missing || rollback ? (fallback ?? null) : null;
  }
  const attention =
    recovery ||
    state?.stage === 'unknown' ||
    state?.stage === 'recovering' ||
    state?.stage === 'failed';
  const active = Boolean(state && ACTIVE.has(state.stage));
  const phase =
    state?.stage === 'deferred' && state.availableActions.includes('accept')
      ? 1
      : phaseFor((attention ? state?.lastProvenStage : state?.stage) ?? 'idle');
  const ready = state?.nativeSuccess === true;
  const title = t(
    attention
      ? 'appUpdateAttentionTitle'
      : ready
        ? 'appUpdateReadyTitle'
        : !state || ['idle', 'cancelled'].includes(state.stage)
          ? 'appUpdateStatusTitle'
          : 'releaseNoticeTitle',
    {
      version: state?.candidate?.version ?? agent.agentVersion ?? ''
    }
  );
  const body: TranslationKey = !connected
    ? 'appUpdateReconnecting'
    : recovery && !state
      ? 'appUpdateUpdaterUnavailable'
      : attention
        ? recoveryMessage(state)
        : !state
          ? 'appUpdateStatusUnavailable'
          : ready
            ? 'appUpdateReady'
            : state.stage === 'native_ready'
              ? 'appUpdateReadiness'
              : active
                ? phase === 0
                  ? 'appUpdateDownloading'
                  : phase === 1
                    ? 'appUpdateWaiting'
                    : 'appUpdateInstalling'
                : state.stage === 'deferred'
                  ? 'appUpdateDeferred'
                  : state.stage === 'cancelled'
                    ? 'appUpdateCancelled'
                    : state.stage === 'idle'
                      ? checkedCurrent && !error
                        ? 'appUpdateCurrent'
                        : 'appUpdateCheckReady'
                      : state.stage === 'prepared'
                        ? 'appUpdatePrepared'
                        : 'appUpdateAvailable';
  const stages: ProgressStage[] = ['appUpdatePrepare', 'appUpdateWait', 'appUpdateInstall'].map(
    (key, index) => ({
      id: key,
      label: t(key as TranslationKey),
      state:
        ready || index < phase
          ? 'complete'
          : index === phase
            ? attention
              ? 'attention'
              : active
                ? 'active'
                : 'pending'
            : 'pending',
      ...(index === 0 && state?.stage === 'preparing' && state.totalBytes
        ? { fraction: state.downloadedBytes / state.totalBytes }
        : {})
    })
  );
  const canPrepare = state?.availableActions.includes('prepare');
  const canAccept = state?.availableActions.includes('accept');
  const canCheck =
    (attention || state?.stage === 'idle' || state?.stage === 'cancelled') &&
    state?.availableActions.includes('check');
  // A runtime that explicitly disabled its updater needs a repair path. A
  // temporary failure or unknown replacement outcome does not justify reinstalling.
  const manualRecovery = recovery && (!state || state.availableActions.length === 0);
  const closeDialog = () => {
    returnToWork.current = completedAttempt !== null;
    if (completedAttempt) {
      setDismissed(completedAttempt);
      try {
        localStorage.setItem(DISMISSED_NATIVE_UPDATE, completedAttempt);
      } catch {
        /* dismissal remains local to this page */
      }
    }
    setOpen(false);
  };

  return (
    <>
      <aside
        className="release-update-notice native-update-notice"
        hidden={open || Boolean(center)}
        role="region"
        aria-labelledby={id}
      >
        <div className="release-update-mark" aria-hidden="true">
          {ready ? (
            <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          ) : (
            <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          )}
        </div>
        <div className="release-update-copy">
          <span className="release-update-eyebrow">{t('releaseNoticeEyebrow')}</span>
          <h2 id={id}>{title}</h2>
          <p className="prose" role="status" aria-live="polite">
            {t(body, { version: agent.agentVersion ?? '' })}
          </p>
        </div>
        <div className="release-update-actions">
          {ready && (
            <Button variant="ghost" onClick={closeDialog}>
              {t('appUpdateDone')}
            </Button>
          )}
          <Button
            ref={trigger}
            color={canAccept ? 'primary' : 'neutral'}
            variant={canAccept ? 'solid' : 'outline'}
            onClick={event => {
              opener.current = event.currentTarget;
              setOpen(true);
            }}
          >
            {t('appUpdateDetails')}
          </Button>
        </div>
      </aside>
      {open && (
        <Modal
          nested
          size="md"
          labelledBy={`${id}-dialog`}
          onClose={closeDialog}
          returnFocus={opener.current ?? trigger.current}
          className="native-update-dialog"
          footer={
            <>
              {state?.availableActions.includes('cancel') && (
                <Button
                  variant="ghost"
                  disabled={pending || !connected}
                  onClick={() => void act('cancel')}
                >
                  {t('appUpdateCancel')}
                </Button>
              )}
              {state?.availableActions.includes('defer') && (
                <Button
                  variant="ghost"
                  disabled={pending || !connected}
                  onClick={() => void act('defer')}
                >
                  {t('releaseNoticeLater')}
                </Button>
              )}
              {supported && (error || attention || canCheck || !state) && (
                <Button
                  color={!canPrepare && !canAccept ? 'primary' : 'neutral'}
                  variant={!canPrepare && !canAccept ? 'solid' : 'outline'}
                  loading={pending}
                  disabled={!connected}
                  onClick={() => {
                    setCheckedCurrent(false);
                    void (canCheck ? act('check').then(() => setCheckedCurrent(true)) : refresh());
                  }}
                >
                  {t(canCheck ? 'appUpdateCheckAgain' : 'appUpdateRefresh')}
                </Button>
              )}
              {canPrepare && (
                <Button
                  color="primary"
                  loading={pending}
                  disabled={!connected}
                  onClick={() => void act('prepare')}
                >
                  {t(state?.stage === 'failed' ? 'appUpdateRetry' : 'appUpdateDownload')}
                </Button>
              )}
              {canAccept && (
                <Button
                  color="primary"
                  loading={pending}
                  disabled={!connected}
                  onClick={() => void act('accept')}
                >
                  {t('appUpdateAccept')}
                </Button>
              )}
              {ready && (
                <Button color="primary" onClick={closeDialog}>
                  {t('appUpdateDone')}
                </Button>
              )}
            </>
          }
        >
          <div className="native-update-heading">
            <h2 id={`${id}-dialog`}>{title}</h2>
            <IconButton label={t('supportClose')} title="" onClick={closeDialog}>
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            </IconButton>
          </div>
          <p className="prose" role="status" aria-live="polite">
            {t(body, { version: agent.agentVersion ?? '' })}
          </p>
          {state && (active || attention || ready || canAccept) && (
            <StageProgress
              stages={stages}
              label={
                canAccept && !active && !attention && !ready
                  ? t('appUpdateInstallReady')
                  : stages[phase]!.label
              }
              stepsLabel={t('appUpdateSteps')}
              active={active && connected}
            />
          )}
          {canAccept && <p className="prose">{t('appUpdateConsent')}</p>}
          {active && <p className="native-update-secondary">{t('appUpdateBackground')}</p>}
          {error && <p role="alert">{t('appUpdateRequestFailed')}</p>}
          {!active && state?.availableActions.includes('set-auto-download') && (
            <Switch
              checked={state.automaticDownload}
              label={t('appUpdateAutoDownload')}
              disabled={pending || !connected}
              onChange={value => void act('set-auto-download', value)}
            />
          )}
          {manualRecovery && (
            <details className="native-update-secondary">
              <summary>{t('appUpdateManualRecovery')}</summary>
              <p>{t('appUpdateManualRecoveryBody')}</p>
              <InstallerDownload intent="update">{t('appUpdateManualDownload')}</InstallerDownload>
            </details>
          )}
        </Modal>
      )}
    </>
  );
}
