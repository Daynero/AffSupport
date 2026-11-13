import { useId, type ReactNode } from 'react';
import { Check, Download, RefreshCw } from 'lucide-react';
import { useAgent } from '../AgentContext';
import { useI18n } from '../i18n';
import { useNativeAppUpdate } from '../updates/useNativeAppUpdate';
import { Button, IconButton } from './ui/Button';
import { StageProgress, type ProgressStage } from './ui/StageProgress';
import { ICON_SIZE, ICON_STROKE } from './icons';
import { InstallerDownload } from './InstallerDownload';
export function NativeAppUpdateNotice({ fallback }: { fallback?: ReactNode }) {
  const agent = useAgent();
  const { t } = useI18n();
  const id = useId();
  const supported = agent.capabilities.includes('native-app-updates-v1');
  const { state, error, pending, act, refresh } = useNativeAppUpdate(
    supported,
    agent.connection === 'connected',
    agent.agentBuildId
  );
  const recovery = agent.agentRuntime?.nativeAppUpdateStatus === 'recovery_required';
  if (!recovery && (!state || ['idle', 'cancelled', 'ui_visible'].includes(state.stage))) {
    const manifest =
      agent.releaseManifest.status === 'ready' ? agent.releaseManifest.manifest : null;
    const target = agent.agentRuntime?.packageTarget;
    const missing =
      (target === 'macos-arm64' || target === 'macos-x64') &&
      manifest &&
      !manifest.nativeUpdates?.[target];
    return missing ? (fallback ?? null) : null;
  }
  const attention =
    recovery ||
    state?.stage === 'unknown' ||
    state?.stage === 'recovering' ||
    state?.stage === 'failed';
  const active =
    state &&
    [
      'preparing',
      'consented',
      'draining',
      'drained',
      'install_committed',
      'replacement_started',
      'relaunch_requested',
      'target_started'
    ].includes(state.stage);
  const phase =
    !state || ['offered', 'preparing', 'prepared', 'deferred'].includes(state.stage)
      ? 0
      : ['consented', 'draining', 'drained'].includes(state.stage)
        ? 1
        : 2;
  const stages: ProgressStage[] = ['appUpdatePrepare', 'appUpdateWait', 'appUpdateInstall'].map(
    (key, index) => ({
      id: key,
      label: t(key as 'appUpdatePrepare' | 'appUpdateWait' | 'appUpdateInstall'),
      state:
        state?.nativeSuccess || index < phase
          ? 'complete'
          : index === phase
            ? attention
              ? 'attention'
              : 'active'
            : 'pending',
      ...(index === 0 && state?.stage === 'preparing' && state.totalBytes
        ? { fraction: state.downloadedBytes / state.totalBytes }
        : {})
    })
  );
  const connected = agent.connection === 'connected';
  return (
    <aside className="release-update-notice" role="region" aria-labelledby={id}>
      <div className="release-update-mark" aria-hidden="true">
        <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </div>
      <div className="release-update-copy">
        <span className="release-update-eyebrow">{t('releaseNoticeEyebrow')}</span>
        <h2 id={id}>
          {t(
            attention
              ? 'appUpdateAttentionTitle'
              : state?.nativeSuccess
                ? 'appUpdateReadyTitle'
                : 'releaseNoticeTitle',
            { version: state?.candidate?.version ?? agent.agentVersion ?? '' }
          )}
        </h2>
        <p className="prose" role="status" aria-live="polite">
          {t(
            !connected
              ? 'appUpdateReconnecting'
              : attention
                ? 'appUpdateRecovery'
                : active
                  ? phase === 0
                    ? 'appUpdateDownloading'
                    : phase === 1
                      ? 'appUpdateWaiting'
                      : 'appUpdateInstalling'
                  : state?.nativeSuccess
                    ? 'appUpdateReady'
                    : 'appUpdateConsent'
          )}
        </p>
        {active && (
          <StageProgress
            stages={stages}
            label={stages[phase]!.label}
            stepsLabel={t('appUpdateSteps')}
            active={connected}
          />
        )}
        {error && <small role="alert">{t('appUpdateRequestFailed')}</small>}
        {state?.availableActions.includes('set-auto-download') && (
          <div className="start-duration-row">
            <div className="fit-mode-pictos is-single">
              <button
                type="button"
                role="checkbox"
                aria-checked={state.automaticDownload}
                title={t('appUpdateAutoDownload')}
                aria-label={t('appUpdateAutoDownload')}
                className={state.automaticDownload ? 'is-selected' : ''}
                disabled={pending || !connected}
                onClick={() => void act('set-auto-download', !state.automaticDownload)}
              >
                <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} />
              </button>
            </div>
            <small>{t('appUpdateAutoDownload')}</small>
          </div>
        )}
      </div>
      <div className="release-update-actions">
        {state?.availableActions.includes('prepare') && (
          <Button
            color="success"
            loading={pending}
            disabled={!connected}
            onClick={() => void act('prepare')}
          >
            {t('appUpdateDownload')}
          </Button>
        )}
        {state?.availableActions.includes('accept') && (
          <Button
            variant="primary"
            loading={pending}
            disabled={!connected}
            onClick={() => void act('accept')}
          >
            {t('appUpdateAccept')}
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
        {state?.availableActions.includes('cancel') && (
          <Button
            variant="ghost"
            disabled={pending || !connected}
            onClick={() => void act('cancel')}
          >
            {t('appUpdateCancel')}
          </Button>
        )}
        {attention && (
          <InstallerDownload intent="update">{t('appUpdateReinstall')}</InstallerDownload>
        )}
        {(error || attention) && (
          <IconButton
            label={t('appUpdateRefresh')}
            disabled={pending || !connected}
            onClick={() => void refresh()}
          >
            <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
        )}
      </div>
    </aside>
  );
}
