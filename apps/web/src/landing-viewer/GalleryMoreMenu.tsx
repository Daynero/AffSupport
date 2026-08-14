import { useI18n } from '../i18n';
import type { LandingViewerSourceCapabilities } from './types';

/**
 * Overflow menu for the rare / destructive actions only (feature 004 UX). Folder switching and
 * refresh now live in dedicated toolbar controls, so this keeps just cache clearing and removing
 * the folder. Presentational: every action is an injected callback (confirmation prompts live in
 * the caller), and each entry renders only when the source advertises that capability.
 */
export function GalleryMoreMenu({
  running,
  hasActiveCatalog,
  capabilities,
  onClearCache,
  onRemoveActiveCatalog
}: {
  running: boolean;
  hasActiveCatalog: boolean;
  capabilities: LandingViewerSourceCapabilities;
  onClearCache: () => void;
  onRemoveActiveCatalog: () => void;
}) {
  const { t } = useI18n();
  if (!capabilities.clearCache && !capabilities.removeCatalog) return null;
  return (
    <details className="landing-gallery-more">
      <summary
        className="landing-gallery-delayed-tooltip"
        data-tooltip={t('landingGalleryMoreActions')}
        aria-label={t('landingGalleryMoreActions')}
      >
        •••
      </summary>
      <div>
        {capabilities.clearCache && (
          <button type="button" disabled={running} onClick={onClearCache}>
            {t('landingGalleryClearCache')}
          </button>
        )}
        {capabilities.removeCatalog && (
          <button
            type="button"
            className="is-danger"
            disabled={running || !hasActiveCatalog}
            onClick={onRemoveActiveCatalog}
          >
            {t('landingGalleryRemoveActiveCatalog')}
          </button>
        )}
      </div>
    </details>
  );
}
