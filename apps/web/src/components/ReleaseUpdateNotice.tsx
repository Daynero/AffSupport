import { useEffect, useId, useRef, useState } from 'react';
import { useAgent } from '../AgentContext';
import { analytics } from '../analytics/service';
import { markAgentInstallStarted } from '../api/client';
import { useI18n } from '../i18n';
import {
  installedReleaseStatus,
  localizedReleaseSummary,
  macAppleSiliconDownloadUrl
} from '../release-manifest';

const DISMISSED_RELEASE_KEY = 'wishly.release-notice.dismissed.v1';

export default function ReleaseUpdateNotice() {
  const { agentVersion, agentChannel, connection, releaseManifest, state, toolAvailable } =
    useAgent();
  const { language, t } = useI18n();
  const titleId = useId();
  const promptedBuild = useRef<string | null>(null);
  const [dismissedBuild, setDismissedBuild] = useState<string | null>(() =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem(DISMISSED_RELEASE_KEY)
  );
  const manifest = releaseManifest.status === 'ready' ? releaseManifest.manifest : null;
  const status = installedReleaseStatus({
    manifest,
    installedVersion: agentVersion,
    installedChannel: agentChannel,
    compatible: toolAvailable('compressor')
  });
  const updateAlreadyInstalled =
    state.update?.state === 'pending' || state.update?.state === 'draining';
  const visible =
    Boolean(manifest) &&
    Boolean(agentVersion) &&
    connection !== 'checking' &&
    !updateAlreadyInstalled &&
    (status === 'update_available' || status === 'update_required') &&
    dismissedBuild !== manifest?.buildId;

  useEffect(() => {
    if (!visible || !manifest || promptedBuild.current === manifest.buildId) return;
    promptedBuild.current = manifest.buildId;
    analytics.track('update_available', {});
    analytics.track('update_prompt_shown', {});
  }, [manifest, visible]);

  if (!visible || !manifest) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_RELEASE_KEY, manifest.buildId);
    setDismissedBuild(manifest.buildId);
    analytics.track('update_dismissed', {});
  };
  const summary = localizedReleaseSummary(manifest, language) ?? t('releaseNoticeMaintenance');

  return (
    <aside
      className="release-update-notice"
      role="region"
      aria-live="polite"
      aria-labelledby={titleId}
    >
      <button
        className="release-update-close"
        type="button"
        aria-label={t('supportClose')}
        onClick={dismiss}
      >
        ✕
      </button>
      <div className="release-update-mark" aria-hidden="true">
        W
      </div>
      <div className="release-update-copy">
        <span className="release-update-eyebrow">{t('releaseNoticeEyebrow')}</span>
        <h2 id={titleId}>{t('releaseNoticeTitle', { version: manifest.version })}</h2>
        <p>{summary}</p>
        <small>{t('releaseNoticeInstruction')}</small>
      </div>
      <div className="release-update-actions">
        <a
          className="button button-primary"
          href={macAppleSiliconDownloadUrl(manifest)}
          onClick={() => {
            markAgentInstallStarted();
            analytics.track('update_started', {});
          }}
        >
          {t('releaseNoticeDownload')}
        </a>
        <button className="text-button" type="button" onClick={dismiss}>
          {t('releaseNoticeLater')}
        </button>
      </div>
    </aside>
  );
}
