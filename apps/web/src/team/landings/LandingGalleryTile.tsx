import type { LandingGalleryItem } from '@video-compressor/shared';
import { useI18n } from '../../i18n';

/**
 * One landing in the gallery (feature 004). Every tile is openable — opening hands off to the
 * existing view-gated `MaterialPreview`, which renders the landing via the paired agent and
 * reports agent-required / unavailable states truthfully. A shared render thumbnail, when one
 * exists, is shown as a progressive enhancement (US3); until then the tile shows a neutral
 * placeholder plus the landing name, never a false "ready" preview.
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
  return (
    <button
      type="button"
      className={`landing-tile landing-tile-${item.tile}`}
      data-tile-state={item.tile}
      aria-label={`${t('teamLandingOpen')}: ${item.material.name}`}
      onClick={() => onOpen(item)}
    >
      <span className="landing-tile-thumb">
        {thumbnailSrc ? (
          <img src={thumbnailSrc} alt="" loading="lazy" />
        ) : (
          <span className="landing-tile-chip" aria-hidden="true" />
        )}
      </span>
      <span className="landing-tile-name">{item.material.name}</span>
      {item.isCandidate && (
        <span className="landing-tile-state">{t('teamLandingTileCandidate')}</span>
      )}
    </button>
  );
}
