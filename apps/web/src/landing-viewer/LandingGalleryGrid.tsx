import type { LandingPreviewItem } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { Spinner } from '../components/ui';
import { useEffect, useState } from 'react';

export function LandingGalleryGrid({
  landings,
  selectedId,
  imageUrl,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  imageUrl: (item: LandingPreviewItem, segment: number) => string | Promise<string | null> | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="landing-gallery-grid">
      {landings.map(item => (
        <button
          key={item.id}
          type="button"
          className={`landing-gallery-grid-tile ${item.id === selectedId ? 'is-selected' : ''} ${item.stale ? 'is-stale' : ''}`}
          onClick={() => onSelect(item.id)}
          title={item.relativePath}
        >
          <span className="landing-gallery-grid-thumb">
            {item.previewAvailable ? (
              <GalleryThumbnail item={item} imageUrl={imageUrl} />
            ) : item.status === 'failed' ? (
              <em>{t('landingGalleryStatusFailed')}</em>
            ) : (
              <Spinner />
            )}
          </span>
          <span className="landing-gallery-grid-name">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One tile's image, resolved through a capability ticket.
 *
 * The grid renders many of these, and the ticket for a given landing is cached
 * in the client, so a scroll costs one request per landing rather than one per
 * tile.
 */
function GalleryThumbnail({
  item,
  imageUrl
}: {
  item: LandingPreviewItem;
  imageUrl: (item: LandingPreviewItem, segment: number) => string | Promise<string | null> | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.resolve(imageUrl(item, 0)).then(next => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
  }, [imageUrl, item]);
  if (!url) return null;
  return <img src={url} alt="" loading="lazy" draggable={false} />;
}
