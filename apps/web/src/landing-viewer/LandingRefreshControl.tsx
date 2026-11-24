import { ChevronDown, RefreshCw, RotateCcw } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { GalleryIconButton } from './internal/GalleryIconButton';
import { ViewerMenu } from './internal/ViewerMenu';

/**
 * "Refresh the folder" picks up new and changed landings; the caret beside it holds the
 * rarer choices. A team space re-imports as a whole, so it gets the one button only.
 */
export function LandingRefreshControl({
  running,
  openingTeam,
  isTeam,
  hasSelection,
  onRefreshFolder,
  onRefreshCurrent,
  onRebuildAll
}: {
  running: boolean;
  openingTeam: boolean;
  isTeam: boolean;
  hasSelection: boolean;
  onRefreshFolder: () => void;
  onRefreshCurrent: () => void;
  onRebuildAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="lv-group lv-refresh">
      <GalleryIconButton
        label={t('landingGalleryRefreshFolder')}
        className="has-label is-secondary"
        disabled={running || openingTeam}
        onClick={onRefreshFolder}
      >
        <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="action-label">{t('landingGalleryRefreshFolder')}</span>
      </GalleryIconButton>
      {!isTeam && (
        <ViewerMenu
          label={t('landingGalleryRefreshMore')}
          triggerClassName="lv-refresh-more"
          trigger={<ChevronDown size={16} strokeWidth={2} aria-hidden="true" />}
          items={[
            {
              id: 'refresh-current',
              icon: <RefreshCw size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
              label: t('landingGalleryRefreshCurrent'),
              disabled: running || !hasSelection,
              onSelect: onRefreshCurrent
            },
            {
              id: 'rebuild-all',
              icon: <RotateCcw size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />,
              label: t('landingGalleryRebuildAll'),
              disabled: running,
              onSelect: onRebuildAll
            }
          ]}
        />
      )}
    </div>
  );
}
