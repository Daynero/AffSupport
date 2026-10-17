import { useId } from 'react';
import { FileSpreadsheet, Film, Link, Megaphone, Settings2, TriangleAlert } from 'lucide-react';
import { Alert, Button, Card } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
export function LaunchChangeReview({
  impact,
  restitch,
  unsavedOutputs,
  disabled,
  onConfirm,
  onCancel
}: {
  impact: {
    namesChanged: boolean;
    urlChanged: boolean;
    catalogChanged: boolean;
    mediaChanged: boolean;
  };
  restitch: boolean;
  unsavedOutputs: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const videoChanged = restitch && impact.mediaChanged;
  const changes = [
    ...(impact.namesChanged ? [{ Icon: Megaphone, label: t('launchesReviewCampaigns') }] : []),
    ...(impact.urlChanged ? [{ Icon: Link, label: t('launchesReviewUrl') }] : []),
    ...(impact.catalogChanged
      ? [{ Icon: FileSpreadsheet, label: t('launchesReviewCatalog') }]
      : []),
    ...(videoChanged ? [{ Icon: Film, label: t('launchesReviewVideo') }] : [])
  ];
  if (changes.length === 0) {
    changes.push({ Icon: Settings2, label: t('launchesReviewConfigOnly') });
  }
  return (
    <Card
      as="section"
      className="launch-change-review"
      title={t('launchesReviewTitle')}
      titleId={titleId}
    >
      <ul className="launch-change-review-items">
        {changes.map(({ Icon, label }) => (
          <li key={label}>
            <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{label}</span>
          </li>
        ))}
      </ul>
      {unsavedOutputs && (
        <Alert color="warning" icon={<TriangleAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} />}>
          {t('launchesReviewUnsavedOutputs')}
        </Alert>
      )}
      <div className="launch-change-review-footer">
        <p>{t('launchesReviewHistory')}</p>
        <div className="launch-change-review-actions">
          <Button variant="ghost" disabled={disabled} onClick={onCancel}>
            {t('launchesReviewBack')}
          </Button>
          <Button color="primary" variant="solid" disabled={disabled} onClick={onConfirm}>
            {t('launchesReviewConfirm')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
