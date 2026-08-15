import { useState, type MouseEvent } from 'react';
import type { LibraryAssetSummary } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { MediaActionIcon } from './mediaActionIcons';
import { VideoTextActions } from './VideoTextActions';
import { LibraryShareActions } from './LibraryShareActions';
import {
  LibraryAssetVisualPreview,
  type LibraryAssetVisualPreviewClient
} from './LibraryAssetVisualPreview';

function sizeLabel(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function isUsefulMetadata(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return (
    normalized.length > 0 && normalized !== 'unknown' && normalized !== 'n/a' && normalized !== '-'
  );
}

export function LibraryAssetCard({
  asset,
  selected = false,
  selectable = false,
  onSelect,
  onPreview,
  onCreateTask,
  onEditPlacement,
  onTranscribe,
  previewClient
}: {
  asset: LibraryAssetSummary;
  selected?: boolean;
  selectable?: boolean;
  onSelect?: (selected: boolean) => void;
  onPreview?: (asset: LibraryAssetSummary) => void;
  onCreateTask?: (asset: LibraryAssetSummary) => void;
  onEditPlacement?: (asset: LibraryAssetSummary) => void;
  onTranscribe?: (asset: LibraryAssetSummary) => void;
  previewClient?: LibraryAssetVisualPreviewClient;
}) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = useState(false);
  const size = sizeLabel(asset.sizeBytes);
  const metadata = [asset.offer, asset.language, asset.type].filter(isUsefulMetadata);
  const placementLabel =
    asset.placementState === 'ready'
      ? t('creativeLibraryPlacementReady')
      : asset.placementState === 'unplaced'
        ? t('creativeLibraryPlacementNeedsAttention')
        : t('creativeLibraryPlacementState', { state: asset.placementState });

  // Clicking any free area of the tile (title, tags, status, padding) toggles
  // selection; genuine controls (buttons, the preview, form fields) opt out so
  // preview and per-item actions still work.
  const toggleFromCard = (event: MouseEvent<HTMLElement>) => {
    if (!selectable) return;
    if ((event.target as HTMLElement).closest('button, a, input, select, label')) return;
    onSelect?.(!selected);
  };

  return (
    <article
      className={`creative-library-card ${selected ? 'is-selected' : ''}`.trim()}
      data-placement-state={asset.placementState}
      data-selectable={selectable ? 'true' : undefined}
      onClick={selectable ? toggleFromCard : undefined}
    >
      {selectable && (
        <label
          className={`creative-library-card-select ${selected ? 'is-selected' : ''}`.trim()}
          onClick={event => {
            event.stopPropagation();
          }}
        >
          <input
            type="checkbox"
            checked={selected}
            aria-label={t('creativeLibrarySelectAsset', { name: asset.name })}
            onChange={event => onSelect?.(event.target.checked)}
          />
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="m4.5 10.6 3.4 3.4 7.6-7.9" />
          </svg>
        </label>
      )}
      <LibraryAssetVisualPreview asset={asset} onPreview={onPreview} client={previewClient} />
      <div className="creative-library-card-body">
        <div className="creative-library-card-title">
          <strong title={asset.name}>{asset.name}</strong>
        </div>
        <div className="creative-library-card-tags">
          {metadata.length > 0 ? (
            metadata.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)
          ) : (
            <span className="creative-library-card-needs-metadata">
              {t('creativeLibraryMetadataMissing')}
            </span>
          )}
          {size && <span>{size}</span>}
        </div>
        <p className="creative-library-card-state" data-placement-state={asset.placementState}>
          {placementLabel}
        </p>
        <div className="creative-library-card-primary-actions">
          {onCreateTask && (
            <Button
              type="button"
              variant="ghost"
              className="team-media-action is-task"
              onClick={() => onCreateTask(asset)}
            >
              <MediaActionIcon kind="task" />
              <span>{t('creativeLibraryCreateTask')}</span>
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen(current => !current)}
          >
            {actionsOpen ? t('creativeLibraryLessActions') : t('creativeLibraryMoreActions')}
          </Button>
        </div>
        {actionsOpen && (
          <div className="creative-library-card-more-actions">
            {onEditPlacement && (
              <Button type="button" variant="ghost" onClick={() => onEditPlacement(asset)}>
                {t('creativeLibraryEditPlacement')}
              </Button>
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
        )}
      </div>
    </article>
  );
}
