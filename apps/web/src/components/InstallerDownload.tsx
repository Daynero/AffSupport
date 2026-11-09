import { useId, type ReactNode } from 'react';
import { useAgent } from '../AgentContext';
import { useI18n } from '../i18n';
import {
  installerChoices,
  resolveInstallerDownload,
  type DownloadPlatform
} from '../release-manifest';
import { markAgentInstallStarted } from '../api/client';
import { analytics } from '../analytics/service';
import type { AnalyticsProperties } from '../analytics/events';
import { currentBrowserPlatform, platformFromAgentCapabilities } from '../lib/platform';
import { Button, uiClasses } from './ui';

/** Shared manual installer handoff. Unknown Macs choose a processor explicitly. */
export function InstallerDownload({
  children,
  onDownload,
  intent = 'install',
  toolIdentifier
}: {
  children?: ReactNode;
  onDownload?: () => void;
  intent?: 'install' | 'update';
  /** The tool that asked for the installer, kept on the event as before 049. */
  toolIdentifier?: AnalyticsProperties['tool_identifier'];
}) {
  const { releaseManifest, agentRuntime, capabilities } = useAgent();
  const { t } = useI18n();
  const unavailableId = useId();
  const result = resolveInstallerDownload(releaseManifest.manifest, agentRuntime);
  const choices: DownloadPlatform[] =
    result.status === 'choice-required'
      ? installerChoices(
          agentRuntime?.platform === 'macos' ||
            platformFromAgentCapabilities(capabilities) === 'macos',
          currentBrowserPlatform() === 'windows'
        )
      : [result.platform];
  return (
    <span className="inline-actions">
      {/* Several processor choices keep the caller's wording as their context. */}
      {choices.length > 1 && children && <span>{children}</span>}
      {choices.map(platform => {
        const selection = resolveInstallerDownload(
          releaseManifest.manifest,
          agentRuntime,
          platform
        );
        const label =
          choices.length === 1 && children
            ? children
            : t(
                platform === 'macos-x64'
                  ? 'macIntel'
                  : platform === 'macos-arm64'
                    ? 'macAppleSilicon'
                    : 'windows'
              );
        return selection.status === 'available' ? (
          <a
            key={platform}
            className={uiClasses('button', {
              color: choices.length > 1 ? 'neutral' : 'primary',
              variant: choices.length > 1 ? 'outline' : 'solid',
              size: 'md'
            })}
            href={selection.url}
            onClick={() => {
              markAgentInstallStarted();
              analytics.track(intent === 'update' ? 'update_started' : 'install_download_clicked', {
                installer_target: platform,
                ...(toolIdentifier ? { tool_identifier: toolIdentifier } : {})
              });
              onDownload?.();
            }}
          >
            {label}
          </a>
        ) : (
          <Button
            key={platform}
            disabled
            aria-describedby={unavailableId}
            title={t('installerUnavailable')}
          >
            {label}
          </Button>
        );
      })}
      {choices.some(
        platform =>
          resolveInstallerDownload(releaseManifest.manifest, agentRuntime, platform).status !==
          'available'
      ) && <small id={unavailableId}>{t('installerUnavailable')}</small>}
    </span>
  );
}
