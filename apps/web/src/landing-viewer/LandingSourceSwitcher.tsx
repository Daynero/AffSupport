import type { LandingPreviewCatalogSummary } from '@video-compressor/shared';
import { useI18n } from '../i18n';

/**
 * The folder identity that doubles as the folder switcher (feature 004 UX). Clicking the active
 * folder name opens a menu of recent folders plus an explicit "choose another folder" entry — the
 * direct fix for "it isn't obvious how to pick a new folder". Purely presentational.
 */
export function LandingSourceSwitcher({
  catalogs,
  activeCatalogId,
  activeCatalogName,
  landingCount,
  disabled,
  canChooseFolder,
  onActivate,
  onChooseFolder
}: {
  catalogs: LandingPreviewCatalogSummary[];
  activeCatalogId: string | null;
  activeCatalogName: string | null;
  landingCount: number;
  disabled: boolean;
  canChooseFolder: boolean;
  onActivate: (id: string) => void;
  onChooseFolder: () => void;
}) {
  const { t } = useI18n();
  return (
    <details className="landing-gallery-source-switcher">
      <summary
        className="landing-gallery-delayed-tooltip"
        data-tooltip={t('landingGallerySwitchSource')}
        aria-label={t('landingGallerySwitchSource')}
      >
        <span className="landing-gallery-source-icon" aria-hidden="true">
          🗀
        </span>
        <span className="landing-gallery-source-copy">
          <strong>{activeCatalogName}</strong>
          <small>{t('landingGalleryCount', { count: landingCount })}</small>
        </span>
        <span className="landing-gallery-source-caret" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="landing-gallery-source-menu">
        {catalogs.map(catalog => (
          <button
            key={catalog.id}
            type="button"
            aria-current={catalog.id === activeCatalogId}
            disabled={disabled}
            onClick={() => onActivate(catalog.id)}
          >
            <strong>{catalog.name}</strong>
            <small>
              {catalog.sourceAvailable
                ? t('landingGalleryCount', { count: catalog.landingCount })
                : t('landingGalleryUnavailable')}
            </small>
          </button>
        ))}
        {canChooseFolder && (
          <button
            type="button"
            className="landing-gallery-source-add"
            disabled={disabled}
            onClick={onChooseFolder}
          >
            ＋ {t('landingGalleryChooseAnother')}
          </button>
        )}
      </div>
    </details>
  );
}
