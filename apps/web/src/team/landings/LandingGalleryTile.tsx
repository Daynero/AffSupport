import type { LandingGalleryItem, LandingRenderFailureReason } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../../i18n';

const TILE_STATE_COPY: Record<LandingGalleryItem['tile'], TranslationKey> = {
  ready: 'teamLandingTileReady',
  rendering: 'teamLandingTileRendering',
  candidate: 'teamLandingTileCandidate',
  needs_agent: 'teamLandingTileNeedsAgent',
  agent_outdated: 'teamLandingTileAgentOutdated',
  error: 'teamLandingTileError'
};

const UNAVAILABLE_COPY: Record<LandingRenderFailureReason, TranslationKey> = {
  corrupt: 'teamLandingUnavailableCorrupt',
  protected: 'teamLandingUnavailableProtected',
  too_large: 'teamLandingUnavailableTooLarge',
  unsupported: 'teamLandingUnavailableUnsupported',
  render_error: 'teamLandingTileError'
};

/**
 * One landing in the gallery: a rendered thumbnail when a shared render exists, otherwise a
 * truthful state chip (candidate / rendering / needs-agent / outdated / error). Presentational —
 * the caller resolves `thumbnailSrc` (via drive-transfer) and handles `onOpen` (feature 004, US1).
 * A tile is only actionable when it is `ready`; other states never present a false preview.
 */
export function LandingGalleryTile({
  item,
  thumbnailSrc,
  onOpen
}: {
  item: LandingGalleryItem;
  thumbnailSrc?: string | null;
  onOpen: (item: LandingGalleryItem) => void;
}) {
  const { t } = useI18n();
  const isReady = item.tile === 'ready' && !!thumbnailSrc;
  const stateCopy =
    item.tile === 'error' && item.unavailableReason
      ? t(UNAVAILABLE_COPY[item.unavailableReason])
      : t(TILE_STATE_COPY[item.tile]);

  const commonProps = {
    className: `landing-tile landing-tile-${item.tile}`,
    'data-tile-state': item.tile
  } as const;

  const body = (
    <>
      <span className="landing-tile-thumb" aria-hidden={isReady ? undefined : true}>
        {isReady ? (
          <img src={thumbnailSrc ?? undefined} alt="" loading="lazy" />
        ) : (
          <span className="landing-tile-chip" />
        )}
      </span>
      <span className="landing-tile-name">{item.material.name}</span>
      {!isReady && <span className="landing-tile-state">{stateCopy}</span>}
    </>
  );

  if (isReady) {
    return (
      <button
        type="button"
        {...commonProps}
        aria-label={`${t('teamLandingOpen')}: ${item.material.name}`}
        onClick={() => onOpen(item)}
      >
        {body}
      </button>
    );
  }

  // Non-ready tiles are informational, not actionable (no false-ready affordance).
  return (
    <div {...commonProps} aria-label={`${item.material.name}: ${stateCopy}`}>
      {body}
    </div>
  );
}
