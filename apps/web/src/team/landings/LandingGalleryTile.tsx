import type { LandingGalleryItem } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';

const TILE_COPY: Record<LandingGalleryItem['tile'], TranslationKey> = {
  ready: 'teamLandingTileReady',
  candidate: 'teamLandingTileCandidate',
  rendering: 'teamLandingTileRendering',
  needs_agent: 'teamLandingTileNeedsAgent',
  agent_outdated: 'teamLandingTileAgentOutdated',
  error: 'teamLandingTileError'
};

const ERROR_COPY: Record<NonNullable<LandingGalleryItem['unavailableReason']>, TranslationKey> = {
  corrupt: 'teamLandingUnavailableCorrupt',
  protected: 'teamLandingUnavailableProtected',
  too_large: 'teamLandingUnavailableTooLarge',
  unsupported: 'teamLandingUnavailableUnsupported',
  render_error: 'teamLandingTileError'
};

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
  rendering = false,
  renderProgress,
  onRender,
  onCreateTask,
  onOpen
}: {
  item: LandingGalleryItem;
  thumbnailSrc?: string | null;
  rendering?: boolean;
  renderProgress?: number | null;
  onRender?: (item: LandingGalleryItem) => void;
  onCreateTask?: (item: LandingGalleryItem) => void;
  onOpen: (item: LandingGalleryItem) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="landing-tile-shell">
      <button
        type="button"
        className={`landing-tile landing-tile-${item.tile}`}
        data-tile-state={rendering ? 'rendering' : item.tile}
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
        {(rendering || item.tile !== 'ready' || item.unavailableReason) && (
          <span className="landing-tile-state">
            {rendering
              ? renderProgress && renderProgress > 0
                ? t('teamLandingTileRenderingProgress', { progress: Math.round(renderProgress) })
                : t('teamLandingTileRendering')
              : t(
                  item.unavailableReason ? ERROR_COPY[item.unavailableReason] : TILE_COPY[item.tile]
                )}
          </span>
        )}
      </button>
      {onRender && item.tile !== 'ready' && item.tile !== 'rendering' && (
        <Button
          type="button"
          variant="secondary"
          disabled={rendering}
          onClick={() => onRender(item)}
        >
          {item.tile === 'error' ? t('teamLandingRetryPreview') : t('teamLandingCreatePreview')}
        </Button>
      )}
      {onCreateTask && (
        <Button type="button" variant="ghost" onClick={() => onCreateTask(item)}>
          {t('creativeLibraryCreateTask')}
        </Button>
      )}
    </div>
  );
}
