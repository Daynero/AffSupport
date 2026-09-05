import { useEffect, useState } from 'react';
import { FileArchive, Folder, TriangleAlert } from 'lucide-react';
import type { LandingPreviewItem } from '@video-compressor/shared';
import { ICON_STROKE } from '../components/icons';
import { Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import type { LandingViewerSource } from './types';

type ImageUrl = LandingViewerSource['imageUrl'];
type ThumbnailUrl = NonNullable<LandingViewerSource['thumbnailUrl']>;

export function LandingGalleryGrid({
  landings,
  selectedId,
  imageUrl,
  thumbnailUrl,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  imageUrl: ImageUrl;
  thumbnailUrl?: ThumbnailUrl;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="lv-grid" aria-label={t('landingGalleryGrid')}>
      {landings.map(item => {
        const Icon = item.sourceKind === 'zip' ? FileArchive : Folder;
        return (
          <button
            key={item.id}
            type="button"
            className={`lv-tile ${item.id === selectedId ? 'is-selected' : ''}`.trim()}
            aria-current={item.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(item.id)}
          >
            <span className="lv-tile-thumb">
              {item.previewAvailable ? (
                <GalleryThumbnail item={item} imageUrl={imageUrl} thumbnailUrl={thumbnailUrl} />
              ) : item.status === 'failed' ? (
                <span className="lv-tile-state is-failed">
                  <TriangleAlert size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  {t('landingGalleryStatusFailed')}
                </span>
              ) : (
                <span className="lv-tile-state">
                  <Spinner small />
                  {item.status === 'rendering'
                    ? t('landingGalleryStatusRendering')
                    : t('landingGalleryStatusQueued')}
                </span>
              )}
              {item.previewAvailable && item.stale && (
                <span className="lv-tile-badge">{t('landingGalleryStatusStale')}</span>
              )}
            </span>
            <span className="lv-tile-name">
              <Icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{item.name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One tile's picture.
 *
 * The small thumbnail the agent saved beside the preview when it has one; the first
 * full-width slice otherwise. Either way the URL comes through a capability ticket that is
 * cached per landing, so a scroll through the grid costs one request per landing.
 */
function GalleryThumbnail({
  item,
  imageUrl,
  thumbnailUrl
}: {
  item: LandingPreviewItem;
  imageUrl: ImageUrl;
  thumbnailUrl?: ThumbnailUrl;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // Keyed on what changes the picture, not on the item object: every pushed state carries a
  // fresh object for each of forty tiles, and none of them needs a new URL.
  const revision = `${item.id}:${item.renderedAt}:${item.thumbnailAvailable ? 1 : 0}`;
  useEffect(() => {
    let active = true;
    const resolved =
      item.thumbnailAvailable && thumbnailUrl ? thumbnailUrl(item) : imageUrl(item, 0);
    void Promise.resolve(resolved).then(next => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
  }, [imageUrl, thumbnailUrl, revision]);
  if (!url) return null;
  return <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />;
}
