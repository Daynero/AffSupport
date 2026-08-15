import type { CatalogSearchResponse, LandingGalleryItem } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';
import { LandingGalleryTile } from './LandingGalleryTile';
import { Button } from '../../components/ui';

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
  page = 1,
  total = items.length,
  pageSize = 50,
  onPageChange,
  emptyMessage,
  renderingMaterialId,
  renderProgress,
  onRender,
  onCreateTask,
  onOpen
}: {
  items: LandingGalleryItem[];
  loading: boolean;
  error: boolean;
  freshness?: Freshness;
  resolveThumbnail?: (item: LandingGalleryItem) => string | null;
  page?: number;
  total?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  emptyMessage?: string;
  renderingMaterialId?: string | null;
  renderProgress?: number | null;
  onRender?: (item: LandingGalleryItem) => void;
  onCreateTask?: (item: LandingGalleryItem) => void;
  onOpen: (item: LandingGalleryItem) => void;
}) {
  const { t } = useI18n();

  if (error) {
    return (
      <div className="team-landings-state" role="alert">
        {t('teamLandingsError')}
      </div>
    );
  }

  if (loading && !items.length) {
    return (
      <div className="team-landings-state" aria-busy="true">
        {t('teamLandingsLoading')}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="team-landings-empty">
        <p>{emptyMessage ?? t('teamLandingsEmpty')}</p>
      </div>
    );
  }

  const count =
    total === 1 ? t('teamLandingsCountOne') : t('teamLandingsCountMany', { count: total });

  return (
    <section className="team-landings-gallery" aria-label={t('teamLandingsTitle')}>
      <header className="team-landings-gallery-head">
        <span className="team-landings-count">{count}</span>
        {freshness && (
          <span className="team-landings-freshness" data-freshness={freshness.state}>
            {t(FRESHNESS_COPY[freshness.state])}
          </span>
        )}
      </header>
      <ul className="team-landings-grid">
        {items.map(item => (
          <li key={item.material.id}>
            <LandingGalleryTile
              item={item}
              thumbnailSrc={resolveThumbnail?.(item) ?? null}
              rendering={renderingMaterialId === item.material.id}
              renderProgress={renderingMaterialId === item.material.id ? renderProgress : undefined}
              onRender={onRender}
              onCreateTask={onCreateTask}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ul>
      {onPageChange && total > pageSize && (
        <nav className="team-landings-pagination" aria-label={t('teamLandingsTitle')}>
          <Button
            type="button"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            {t('previous')}
          </Button>
          <span className="landing-gallery-page-indicator">
            {page} / {Math.max(1, Math.ceil(total / pageSize))}
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={page * pageSize >= total}
            onClick={() => onPageChange(page + 1)}
          >
            {t('next')}
          </Button>
        </nav>
      )}
    </section>
  );
}
