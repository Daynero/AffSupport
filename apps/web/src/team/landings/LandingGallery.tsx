import type { CatalogSearchResponse, LandingGalleryItem } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';
import { LandingGalleryTile } from './LandingGalleryTile';

type Freshness = CatalogSearchResponse['catalogFreshness'];

const FRESHNESS_COPY: Record<Freshness['state'], TranslationKey> = {
  not_started: 'teamCatalogFreshnessNotStarted',
  scanning: 'teamCatalogFreshnessScanning',
  replaying: 'teamCatalogFreshnessReplaying',
  ready: 'teamCatalogFreshnessReady',
  failed: 'teamCatalogFreshnessFailed',
  unavailable: 'teamCatalogFreshnessUnavailable'
};

/**
 * The team landings gallery grid (feature 004, US1). Presentational: the container
 * (`useTeamLandings`, added after the render RPC types are generated) supplies items, loading /
 * error / freshness state, and the thumbnail resolver. Every member with `view` can browse it;
 * an empty space shows a welcoming empty state with no filters or side panels.
 */
export function LandingGallery({
  items,
  loading,
  error,
  freshness,
  resolveThumbnail,
  onOpen
}: {
  items: LandingGalleryItem[];
  loading: boolean;
  error: boolean;
  freshness?: Freshness;
  resolveThumbnail?: (item: LandingGalleryItem) => string | null;
  onOpen: (item: LandingGalleryItem) => void;
}) {
  const { t } = useI18n();

  if (error) {
    return (
      <div className="landing-gallery-state" role="alert">
        {t('teamLandingsError')}
      </div>
    );
  }

  if (loading && !items.length) {
    return (
      <div className="landing-gallery-state" aria-busy="true">
        {t('teamLandingsLoading')}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="landing-gallery-empty">
        <p>{t('teamLandingsEmpty')}</p>
      </div>
    );
  }

  const count =
    items.length === 1
      ? t('teamLandingsCountOne')
      : t('teamLandingsCountMany', { count: items.length });

  return (
    <section className="landing-gallery" aria-label={t('teamLandingsTitle')}>
      <header className="landing-gallery-head">
        <span className="landing-gallery-count">{count}</span>
        {freshness && (
          <span className="landing-gallery-freshness" data-freshness={freshness.state}>
            {t(FRESHNESS_COPY[freshness.state])}
          </span>
        )}
      </header>
      <ul className="landing-gallery-grid">
        {items.map(item => (
          <li key={item.material.id}>
            <LandingGalleryTile
              item={item}
              thumbnailSrc={resolveThumbnail?.(item) ?? null}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
