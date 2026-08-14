import type { LandingPreviewItem } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { Spinner } from '../components/ui';

export function LandingGalleryGrid({
  landings,
  selectedId,
  imageUrl,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  imageUrl: (item: LandingPreviewItem, segment: number) => string;
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
              <img src={imageUrl(item, 0)} alt="" loading="lazy" draggable={false} />
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
