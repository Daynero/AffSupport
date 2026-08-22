import { useEffect, useId, useRef, useState } from 'react';
import type { SotyToolId } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { agentKnown, agentLocalUrl, markAgentInstallStarted } from '../api/client';
import type { ConnectionState } from '../connection';
import { useI18n } from '../i18n';
import { requireSupabaseClient } from '../lib/supabase';
import { downloadUrlForPlatform, macAppleSiliconDownloadUrl } from '../release-manifest';
import { currentBrowserPlatform, currentWindowsX64Supported } from '../lib/platform';
import { analytics } from '../analytics/service';
import { Modal } from './Modal';
import { SotyMark } from './SotyLogo';
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
  const browserPlatform = currentBrowserPlatform();
  const windowsFirst = windowsDownload.available && browserPlatform === 'windows';
  // Both builds ship unsigned, so every first launch meets an OS warning. The
  // guidance has to be here, at the moment of download, rather than in a help
  // page the user has not opened yet.
  const installNotice = windowsFirst
    ? currentWindowsX64Supported()
      ? t('windowsUnsignedNotice')
      : t('windowsUnsupportedArchitecture')
    : browserPlatform === 'macos'
      ? t('macUnsignedNotice')
      : null;
  const toolIdentifier =
    tool === 'landingOptimizer'
      ? 'landing-optimizer'
      : tool === 'landingPreview'
        ? 'landing-preview'
        : tool === 'transcription'
          ? 'transcription'
          : 'compressor';
  /**
   * Whether opening the Agent's own copy of the app is the way out of here.
   *
   * True for every disconnected state except the two that opening cannot fix:
   * a build too old for this tool needs a download, and one already installing
   * an update needs neither.
   *
   * This used to be offered only for `pairing_required`, which is the one case
   * where the page had already proved the Agent was reachable. The cases where
   * it is NOT reachable are exactly the cases where this link is the only way
   * through — the page cannot see the Agent, so it cannot tell "not installed"
   * apart from "installed, and the browser will not let me look".
   */
  const openingHelps = !updatePending && !needsUpdate && connection !== 'connected';
  // Evidence that Soty is already on this computer — a token, a past
  // connection, or an installer fetched from here. It is the difference between
  // "you need Soty" and "you have Soty — open it", and it decides which action
  // leads. The installers stay on screen either way, so guessing wrong here
  // never strands anyone.
  const installed = openingHelps && agentKnown();
  const title = updatePending
    ? t('localAppBusyUpdateTitle')
    : needsUpdate
      ? t('localAppUpdateTitle')
      : installed
        ? t('localAppOpenTitle')
        : t('localAppDialogTitle');
  const body = updatePending
    ? t('localAppBusyUpdateBody')
    : needsUpdate
      ? t('localAppUpdateBody')
      : installed
        ? t('localAppOpenBody')
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
        <div className="local-app-mark">
          <SotyMark size={54} />
        </div>
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        {installed && (
          // Above the installers, not beside them: someone who already has Soty
          // and is being shown a download button reads the whole dialog as "it
          // did not work", and downloading it a second time does not help them.
          // One click from here is the whole remaining journey — the link
          // carries this tool along, so the Agent opens on it rather than on its
          // home screen.
          <a className="button button-primary local-app-open" href={agentLocalUrl()}>
            {t('openSoty')}
          </a>
        )}
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
        {installNotice && (
          <p className="platform-install-notice">
            {installNotice}
            {windowsFirst && ` ${t('windowsRequirements')}`}
          </p>
        )}
        <div className="inline-actions">
          {openingHelps && !installed && (
            <a className="button button-secondary" href={agentLocalUrl()}>
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
  const [waitlistState, setWaitlistState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const joinWaitlist = async () => {
    if (waitlistState === 'saving' || waitlistState === 'saved') return;
    setWaitlistState('saving');
    const { error } = await requireSupabaseClient().rpc('join_windows_app_waitlist');
    setWaitlistState(error ? 'error' : 'saved');
  };

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
      <div className="local-app-mark">
        <SotyMark size={54} />
      </div>
      <h2 id={titleId}>{t('windowsComingSoonTitle')}</h2>
      <p>{t('windowsComingSoonBody')}</p>
      <div className="dialog-actions">
        <Button
          variant="primary"
          loading={waitlistState === 'saving'}
          disabled={waitlistState === 'saved'}
          onClick={() => void joinWaitlist()}
        >
          {t(waitlistState === 'saved' ? 'windowsAppWaitlistSaved' : 'windowsAppWaitlist')}
        </Button>
        {waitlistState === 'error' && (
          <p className="support-error" role="alert">
            {t('windowsAppWaitlistError')}
          </p>
        )}
      </div>
    </Modal>
  );
}
