import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RELEASE_DOWNLOAD_URL, type WishlyToolId } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { agentUrl, markAgentInstallStarted } from '../api/client';
import type { ConnectionState } from '../connection';
import { useI18n } from '../i18n';
import { releaseArtifact } from '../release-manifest';
import { analytics } from '../analytics/service';
import { Button } from './ui';

export default function LocalAppDialog({
  tool,
  connection,
  onClose
}: {
  tool: WishlyToolId;
  connection: ConnectionState;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const { reconnect, platform, releaseManifest, state, toolAvailable } = useAgent();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const incompatible = connection === 'connected' && !toolAvailable(tool);
  const updatePending = state.update?.state === 'pending' || state.update?.state === 'draining';
  const needsUpdate = incompatible || connection === 'agent_update_required';
  const artifact = releaseArtifact(releaseManifest.manifest, platform);
  const downloadUrl = artifact?.url ?? (platform === 'macos' ? RELEASE_DOWNLOAD_URL : null);
  const title = updatePending
    ? t('localAppBusyUpdateTitle')
    : needsUpdate
      ? t('localAppUpdateTitle')
      : t('localAppDialogTitle');
  const body = updatePending
    ? t('localAppBusyUpdateBody')
    : needsUpdate
      ? t('localAppUpdateBody')
      : t('localAppDialogBody');

  useEffect(() => {
    analytics.track('setup_prompt_shown', {
      tool_identifier: tool === 'landingOptimizer' ? 'landing-optimizer' : 'compressor',
      flow_step: needsUpdate ? 'update_required' : 'install_or_launch'
    });
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('a,button')?.focus());
  }, [needsUpdate, tool]);

  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className="local-app-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {onClose && (
          <button
            className="support-close"
            type="button"
            aria-label={t('supportClose')}
            onClick={onClose}
          >
            ✕
          </button>
        )}
        <div className="local-app-mark" aria-hidden="true">
          W
        </div>
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <div className="inline-actions">
          {downloadUrl && (needsUpdate || !updatePending) && (
            <a
              className="button button-primary"
              href={downloadUrl}
              onClick={() => {
                if (!needsUpdate) markAgentInstallStarted();
                analytics.track(needsUpdate ? 'update_started' : 'install_download_clicked', {
                  tool_identifier: tool === 'landingOptimizer' ? 'landing-optimizer' : 'compressor'
                });
              }}
            >
              {t(needsUpdate ? 'updateWishly' : 'installWishly')}
            </a>
          )}
          {connection === 'pairing_required' && (
            <a className="button button-primary" href={`${agentUrl}/local`}>
              {t('openWishly')}
            </a>
          )}
          {!updatePending && <Button onClick={reconnect}>{t('checkAgain')}</Button>}
        </div>
        {!downloadUrl && !updatePending && <small>{t('platformUnavailable')}</small>}
      </div>
    </div>,
    document.body
  );
}
