import { Button } from '../components/ui';
import { useI18n } from '../i18n';

/**
 * Refresh control (feature 004 UX). The visible action is now "refresh the folder" (pick up new /
 * changed landings) instead of the old, misleading "refresh current" — the fix for "you'd never
 * guess how to update all landings". A caret exposes the finer-grained options. Team catalogues
 * re-import as a whole, so they show a single button with no caret.
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
    <div className="landing-gallery-refresh">
      <Button
        variant="ghost"
        className="landing-gallery-refresh-primary"
        disabled={running || openingTeam}
        onClick={onRefreshFolder}
      >
        <span aria-hidden="true">↻</span> {t('landingGalleryRefreshFolder')}
      </Button>
      {!isTeam && (
        <details className="landing-gallery-refresh-more">
          <summary
            className="landing-gallery-delayed-tooltip"
            data-tooltip={t('landingGalleryRefreshMore')}
            aria-label={t('landingGalleryRefreshMore')}
          >
            ⌄
          </summary>
          <div>
            <button type="button" disabled={running || !hasSelection} onClick={onRefreshCurrent}>
              {t('landingGalleryRefreshCurrent')}
            </button>
            <button type="button" disabled={running} onClick={onRebuildAll}>
              {t('landingGalleryRebuildAll')}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
