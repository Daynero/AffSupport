import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WishlyToolId } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { agentUrl, markAgentInstallStarted } from '../api/client';
import type { ConnectionState } from '../connection';
import { useI18n } from '../i18n';
import { macAppleSiliconDownloadUrl } from '../release-manifest';
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
  const { reconnect, releaseManifest, state, toolAvailable } = useAgent();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const windowsButton = useRef<HTMLButtonElement>(null);
  const [windowsNoticeOpen, setWindowsNoticeOpen] = useState(false);
  const incompatible = connection === 'connected' && !toolAvailable(tool);
  const updatePending = state.update?.state === 'pending' || state.update?.state === 'draining';
  const needsUpdate = incompatible || connection === 'agent_update_required';
  const downloadUrl = macAppleSiliconDownloadUrl(releaseManifest.manifest);
  const toolIdentifier = tool === 'landingOptimizer' ? 'landing-optimizer' : 'compressor';
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
      tool_identifier: toolIdentifier,
      flow_step: needsUpdate ? 'update_required' : 'install_or_launch'
    });
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('a,button')?.focus());
  }, [needsUpdate, toolIdentifier]);

  const closeWindowsNotice = () => {
    setWindowsNoticeOpen(false);
    requestAnimationFrame(() => windowsButton.current?.focus());
  };

  return (
    <>
      {createPortal(
        <div className="modal-backdrop" aria-hidden={windowsNoticeOpen || undefined}>
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
            <div className="platform-download-actions">
              <a
                className="button button-primary"
                href={downloadUrl}
                onClick={() => {
                  if (!needsUpdate) markAgentInstallStarted();
                  analytics.track(needsUpdate ? 'update_started' : 'install_download_clicked', {
                    tool_identifier: toolIdentifier
                  });
                }}
              >
                {t('macAppleSilicon')}
              </a>
              <button
                ref={windowsButton}
                className="button button-secondary"
                type="button"
                onClick={() => {
                  analytics.track('blocked_action_attempted', {
                    tool_identifier: toolIdentifier,
                    action_identifier: 'download_windows',
                    outcome: 'blocked'
                  });
                  setWindowsNoticeOpen(true);
                }}
              >
                {t('windows')}
              </button>
            </div>
            <div className="inline-actions">
              {connection === 'pairing_required' && (
                <a className="button button-secondary" href={`${agentUrl}/local`}>
                  {t('openWishly')}
                </a>
              )}
              {!updatePending && <Button onClick={reconnect}>{t('checkAgain')}</Button>}
            </div>
          </div>
        </div>,
        document.body
      )}
      {windowsNoticeOpen && <WindowsComingSoonDialog onClose={closeWindowsNotice} />}
    </>
  );
}

function WindowsComingSoonDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() =>
      dialog.current?.querySelector<HTMLButtonElement>('.dialog-actions button')?.focus()
    );
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop modal-backdrop-nested"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="local-app-modal windows-coming-soon-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          className="support-close"
          type="button"
          aria-label={t('supportClose')}
          onClick={onClose}
        >
          ✕
        </button>
        <div className="local-app-mark" aria-hidden="true">
          W
        </div>
        <h2 id={titleId}>{t('windowsComingSoonTitle')}</h2>
        <p>{t('windowsComingSoonBody')}</p>
        <div className="dialog-actions">
          <Button variant="primary" onClick={onClose}>
            {t('supportClose')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
