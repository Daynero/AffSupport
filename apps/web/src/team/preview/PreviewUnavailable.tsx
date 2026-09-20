import type { TeamPreviewUnavailableReason } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { EmptyState } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';

const REASON_COPY: Readonly<Record<TeamPreviewUnavailableReason, TranslationKey>> = {
  unsupported: 'teamPreviewUnsupported',
  corrupt: 'teamPreviewCorrupt',
  protected: 'teamPreviewProtected',
  too_large: 'teamPreviewTooLarge',
  agent_required: 'teamPreviewAgentRequired'
};

const LANDING_REASON_COPY: Readonly<Record<TeamPreviewUnavailableReason, TranslationKey>> = {
  unsupported: 'teamLandingUnavailableUnsupported',
  corrupt: 'teamLandingUnavailableCorrupt',
  protected: 'teamLandingUnavailableProtected',
  too_large: 'teamLandingUnavailableTooLarge',
  agent_required: 'teamPreviewAgentRequired'
};

export function PreviewUnavailable({
  reason,
  allowedActions,
  variant = 'default',
  onDownload,
  onNewVersion
}: {
  reason: TeamPreviewUnavailableReason;
  allowedActions: readonly ('download' | 'new_version')[];
  variant?: 'default' | 'landing';
  onDownload?: () => void;
  onNewVersion?: () => void;
}) {
  const { t } = useI18n();
  /*
   * The shared empty state (021, T129): nothing can be shown here, and what can
   * be done about it sits under the sentence rather than somewhere else on the
   * screen. The class stays so the preview pane's own layout still applies.
   */
  return (
    <EmptyState
      className="team-preview-unavailable"
      title={t((variant === 'landing' ? LANDING_REASON_COPY : REASON_COPY)[reason])}
      action={
        allowedActions.length > 0 && (
          <div className="team-preview-actions">
            {allowedActions.includes('download') && (
              <Button type="button" onClick={onDownload}>
                {t('teamPreviewDownload')}
              </Button>
            )}
            {allowedActions.includes('new_version') && (
              <Button type="button" onClick={onNewVersion}>
                {t('teamPreviewNewVersion')}
              </Button>
            )}
          </div>
        )
      }
    />
  );
}
