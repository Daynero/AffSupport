import type { LibraryAssetSummary } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { VideoTextActions } from './VideoTextActions';
import { LibraryShareActions } from './LibraryShareActions';

function sizeLabel(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function categoryGlyph(asset: LibraryAssetSummary): string {
  if (asset.category === 'video') return '▶';
  if (asset.category === 'image') return '▧';
  if (asset.category === 'landing') return '◇';
  if (asset.category === 'transcript') return '≡';
  if (asset.category === 'archive') return '▦';
  return '▤';
}

export function LibraryAssetCard({
  asset,
  selected = false,
  selectable = false,
  onSelect,
  onCreateTask,
  onEditPlacement,
  onTranscribe
}: {
  asset: LibraryAssetSummary;
  selected?: boolean;
  selectable?: boolean;
  onSelect?: (selected: boolean) => void;
  onCreateTask?: (asset: LibraryAssetSummary) => void;
  onEditPlacement?: (asset: LibraryAssetSummary) => void;
  onTranscribe?: (asset: LibraryAssetSummary) => void;
}) {
  const { t } = useI18n();
  const size = sizeLabel(asset.sizeBytes);
  const thumbnailLabel =
    asset.thumbnailState === 'ready'
      ? asset.category === 'video'
        ? t('creativeLibraryVideoFrame', { seconds: (asset.thumbnailTimeMs ?? 1_000) / 1_000 })
        : t('creativeLibraryPreviewReady')
      : asset.thumbnailState === 'running'
        ? t('creativeLibraryEnrichmentPending')
        : asset.thumbnailState === 'pending'
          ? t('creativeLibraryPreviewPending')
          : t('creativeLibraryPreviewUnavailable');

  return (
    <article
      className={`creative-library-card ${selected ? 'is-selected' : ''}`.trim()}
      data-placement-state={asset.placementState}
    >
      <div className="creative-library-card-preview" data-thumbnail-state={asset.thumbnailState}>
        <span aria-hidden="true">{categoryGlyph(asset)}</span>
        <small>{thumbnailLabel}</small>
      </div>
      <div className="creative-library-card-body">
        <div className="creative-library-card-title">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              aria-label={t('creativeLibrarySelectAsset', { name: asset.name })}
              onChange={event => onSelect?.(event.target.checked)}
            />
          )}
          <strong title={asset.name}>{asset.name}</strong>
        </div>
        <div className="creative-library-card-tags">
          <span>{asset.offer}</span>
          <span>{asset.language || 'unknown'}</span>
          <span>{asset.type}</span>
          {size && <span>{size}</span>}
        </div>
        <p className="creative-library-card-state">
          {asset.placementState === 'ready'
            ? t('creativeLibraryPlacementReady')
            : t('creativeLibraryPlacementState', { state: asset.placementState })}
        </p>
        {(onCreateTask || onEditPlacement) && (
          <div className="creative-library-card-actions">
            {onCreateTask && (
              <Button type="button" variant="ghost" onClick={() => onCreateTask(asset)}>
                {t('creativeLibraryCreateTask')}
              </Button>
            )}
            {onEditPlacement && (
              <Button type="button" variant="ghost" onClick={() => onEditPlacement(asset)}>
                {t('creativeLibraryEditPlacement')}
              </Button>
            )}
          </div>
        )}
        {asset.category === 'video' && onTranscribe && (
          <VideoTextActions
            teamId={asset.teamId}
            videoId={asset.id}
            onTranscribe={() => onTranscribe(asset)}
          />
        )}
        <LibraryShareActions teamId={asset.teamId} materialId={asset.id} />
      </div>
    </article>
  );
}
