import { useEffect, useId, useRef, useState } from 'react';
import type { SotyToolId } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { agentUrl, markAgentInstallStarted } from '../api/client';
import type { ConnectionState } from '../connection';
import { useI18n } from '../i18n';
import { downloadUrlForPlatform, macAppleSiliconDownloadUrl } from '../release-manifest';
import { currentBrowserPlatform } from '../lib/platform';
import { analytics } from '../analytics/service';
import { Modal } from './Modal';
import { Button } from './ui';

export default function LocalAppDialog({
  tool,
  connection,
  onClose
}: {
  tool: SotyToolId;
  connection: ConnectionState;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const { reconnect, releaseManifest, state, toolAvailable } = useAgent();
  const titleId = useId();
  const windowsButton = useRef<HTMLButtonElement>(null);
  const [windowsNoticeOpen, setWindowsNoticeOpen] = useState(false);
  const incompatible = connection === 'connected' && !toolAvailable(tool);
  const updatePending = state.update?.state === 'pending' || state.update?.state === 'draining';
  const needsUpdate = incompatible || connection === 'agent_update_required';
  const macDownloadUrl = macAppleSiliconDownloadUrl(releaseManifest.manifest);
  const windowsDownload = downloadUrlForPlatform(releaseManifest.manifest, 'windows-x64');
  const windowsFirst = windowsDownload.available && currentBrowserPlatform() === 'windows';
  const toolIdentifier =
    tool === 'landingOptimizer'
      ? 'landing-optimizer'
      : tool === 'landingPreview'
        ? 'landing-preview'
        : tool === 'transcription'
          ? 'transcription'
          : 'compressor';
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
  }, [needsUpdate, toolIdentifier]);

  const closeWindowsNotice = () => {
    setWindowsNoticeOpen(false);
    requestAnimationFrame(() => windowsButton.current?.focus());
  };

  const trackDownload = () => {
    if (!needsUpdate) markAgentInstallStarted();
    analytics.track(needsUpdate ? 'update_started' : 'install_download_clicked', {
      tool_identifier: toolIdentifier
    });
  };

  const macAction = (
    <a className="button platform-download-button" href={macDownloadUrl} onClick={trackDownload}>
      {t('macAppleSilicon')}
    </a>
  );
  const windowsAction = windowsDownload.available ? (
    <a
      className="button platform-download-button"
      href={windowsDownload.url}
      onClick={trackDownload}
    >
      {t('windows')}
    </a>
  ) : (
    <button
      ref={windowsButton}
      className="button platform-download-button"
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
  );

  return (
    <>
      <Modal
        size="lg"
        className="local-app-modal"
        labelledBy={titleId}
        onClose={onClose}
        closeOnEscape={false}
        closeLabel={t('supportClose')}
        backdropAriaHidden={windowsNoticeOpen}
      >
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <div className="platform-download-actions">
          {windowsFirst ? (
            <>
              {windowsAction}
              {macAction}
            </>
          ) : (
            <>
              {macAction}
              {windowsAction}
            </>
          )}
        </div>
        <div className="inline-actions">
          {connection === 'pairing_required' && (
            <a className="button button-secondary" href={`${agentUrl}/local`}>
              {t('openSoty')}
            </a>
          )}
          {!updatePending && (
            <Button variant="secondary" onClick={reconnect}>
              {t('checkAgain')}
            </Button>
          )}
        </div>
      </Modal>
      {windowsNoticeOpen && <WindowsComingSoonDialog onClose={closeWindowsNotice} />}
    </>
  );
}

function WindowsComingSoonDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();

  return (
    <Modal
      size="sm"
      className="local-app-modal windows-coming-soon-modal"
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={t('supportClose')}
      nested
      initialFocus=".dialog-actions button"
    >
      <h2 id={titleId}>{t('windowsComingSoonTitle')}</h2>
      <p>{t('windowsComingSoonBody')}</p>
      <div className="dialog-actions">
        <Button variant="primary" onClick={onClose}>
          {t('supportClose')}
        </Button>
      </div>
    </Modal>
  );
}
