import { ChevronDown, RefreshCw, RotateCcw } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { GalleryIconButton } from './internal/GalleryIconButton';
import { MenuItem, ViewerMenu } from './internal/ViewerMenu';

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
        >
          {close => (
            <>
              <MenuItem
                icon={
                  <RefreshCw size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />
                }
                disabled={running || !hasSelection}
                onClick={() => {
                  close();
                  onRefreshCurrent();
                }}
              >
                {t('landingGalleryRefreshCurrent')}
              </MenuItem>
              <MenuItem
                icon={
                  <RotateCcw size={ICON_SIZE - 2} strokeWidth={ICON_STROKE} aria-hidden="true" />
                }
                disabled={running}
                onClick={() => {
                  close();
                  onRebuildAll();
                }}
              >
                {t('landingGalleryRebuildAll')}
              </MenuItem>
            </>
          )}
        </ViewerMenu>
      )}
    </div>
  );
}
