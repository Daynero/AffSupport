import { useEffect, useId, useRef, useState } from 'react';
import { useAgent } from '../AgentContext';
import { analytics } from '../analytics/service';
import { useI18n } from '../i18n';
import { installedReleaseStatus, localizedReleaseSummary } from '../release-manifest';
import { InstallerDownload } from './InstallerDownload';
import { siteChannel } from '../lib/config';
import { useReleaseTester } from '../lib/release-tester';

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
  // 051: on the main site, a production agent newer than the signed channel
  // means production was rolled back (or a candidate was cancelled) after this
  // computer installed the newer build. Offer the stable one; installing it in
  // place activates it like any update. A tester trying a candidate is not
  // nagged about the build they are testing.
  const onMainSite = siteChannel() === 'production';
  const tester = useReleaseTester(onMainSite && status === 'newer');
  const returnToStable = onMainSite && status === 'newer' && tester === 'not_tester';
  const visible =
    Boolean(manifest) &&
    Boolean(agentVersion) &&
    connection !== 'checking' &&
    !updateAlreadyInstalled &&
    // `update_required` is no longer a dismissible banner: an unsupported
    // build is stopped at the tool gate, which cannot be waved away.
    (status === 'update_available' || returnToStable) &&
    dismissedBuild !== manifest?.buildId;

  useEffect(() => {
    if (!visible || !manifest || promptedBuild.current === manifest.buildId) return;
    promptedBuild.current = manifest.buildId;
    if (returnToStable) {
      analytics.track('update_prompt_shown', {});
      return;
    }
    analytics.track('update_available', {});
    analytics.track('update_prompt_shown', {});
  }, [manifest, returnToStable, visible]);

  if (!visible || !manifest) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_RELEASE_KEY, manifest.buildId);
    setDismissedBuild(manifest.buildId);
    analytics.track('update_dismissed', {});
  };
  const summary = returnToStable
    ? t('releaseRollbackBody')
    : (localizedReleaseSummary(manifest, language) ?? t('releaseNoticeMaintenance'));

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
        <span className="release-update-eyebrow">
          {t(returnToStable ? 'releaseRollbackEyebrow' : 'releaseNoticeEyebrow')}
        </span>
        <h2 id={titleId}>
          {t(returnToStable ? 'releaseRollbackTitle' : 'releaseNoticeTitle', {
            version: manifest.version
          })}
        </h2>
        <p className="prose">{summary}</p>
        <small>
          {t(returnToStable ? 'releaseRollbackInstruction' : 'releaseNoticeInstruction')}
        </small>
      </div>
      <div className="release-update-actions">
        <InstallerDownload intent="update">
          {t(returnToStable ? 'releaseRollbackDownload' : 'releaseNoticeDownload')}
        </InstallerDownload>
        <button
          className="ui-button ui-button--link ui-button--md ui-color-neutral"
          type="button"
          onClick={dismiss}
        >
          {t('releaseNoticeLater')}
        </button>
      </div>
    </aside>
  );
}
