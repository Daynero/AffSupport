import type { TeamPreviewUnavailableReason } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';

const REASON_COPY: Readonly<Record<TeamPreviewUnavailableReason, TranslationKey>> = {
  unsupported: 'teamPreviewUnsupported',
  corrupt: 'teamPreviewCorrupt',
  protected: 'teamPreviewProtected',
  too_large: 'teamPreviewTooLarge',
  agent_required: 'teamPreviewAgentRequired'
};

export function PreviewUnavailable({
  reason,
  allowedActions,
  onDownload,
  onNewVersion
}: {
  reason: TeamPreviewUnavailableReason;
  allowedActions: readonly ('download' | 'new_version')[];
  onDownload?: () => void;
  onNewVersion?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="team-preview-unavailable" role="status">
      <p>{t(REASON_COPY[reason])}</p>
      {allowedActions.length > 0 && (
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
      )}
    </div>
  );
}
