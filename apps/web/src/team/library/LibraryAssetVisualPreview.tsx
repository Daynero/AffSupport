import { useEffect, useRef, useState } from 'react';
import type { LibraryAssetSummary, TeamPreviewResult } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { thumbnailRelayUrl } from './thumbnailRelay';

export interface LibraryAssetVisualPreviewClient {
  previewMaterial(
    teamId: string,
    materialId: string,
    mode: 'media' | 'transcript' | 'archive' | 'landing'
  ): Promise<TeamPreviewResult>;
}

const defaultClient: LibraryAssetVisualPreviewClient = teamApi;

function categoryGlyph(asset: LibraryAssetSummary): string {
  if (asset.category === 'video') return '▶';
  if (asset.category === 'image') return '▧';
  if (asset.category === 'landing') return '◇';
  if (asset.category === 'transcript') return '≡';
  if (asset.category === 'archive') return '▦';
  return '▤';
}

function videoPreviewTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(1, durationSeconds);
}

/**
 * Displays a real, ephemeral media frame only once the card is near the viewport.
 * The URL comes from the existing safe preview flow and is never persisted as a
 * public Drive URL.
 */
export function LibraryAssetVisualPreview({
  asset,
  onPreview,
  client = defaultClient
}: {
  asset: LibraryAssetSummary;
  onPreview?: (asset: LibraryAssetSummary) => void;
  client?: LibraryAssetVisualPreviewClient;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLButtonElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const visualMedia = asset.category === 'video' || asset.category === 'image';
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    setVisible(false);
    setPreviewUrl(null);
    setThumbnailUrl(null);
    setState('idle');
    if (!visualMedia || !onPreview) return;
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '160px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [asset.category, asset.id, onPreview, visualMedia]);

  useEffect(() => {
    let active = true;
    if (!visible || !visualMedia) return;
    setState('loading');
    void client
      .previewMaterial(asset.teamId, asset.id, 'media')
      .then(result => {
        if (!active) return;
        if (result.kind !== 'media') {
          setState('unavailable');
          return;
        }
        setPreviewUrl(result.rangeUrl);
        setThumbnailUrl(thumbnailRelayUrl(result.rangeUrl));
      })
      .catch(() => {
        if (active) setState('unavailable');
      });
    return () => {
      active = false;
    };
  }, [asset.id, asset.teamId, client, visible, visualMedia]);

  const markUnavailable = () => setState('unavailable');
  const fallBackToRangePreview = () => setThumbnailUrl(null);
  const seekVideoFrame = () => {
    const element = video.current;
    if (!element) return;
    const target = videoPreviewTime(element.duration);
    if (target === 0) {
      setState('ready');
      return;
    }
    try {
      element.currentTime = target;
    } catch {
      markUnavailable();
    }
  };

  const fallbackLabel =
    state === 'unavailable'
      ? t('creativeLibraryPreviewUnavailable')
      : visualMedia
        ? t('creativeLibraryPreviewLoading')
        : asset.thumbnailState === 'ready'
          ? asset.category === 'video'
            ? t('creativeLibraryVideoFrame', { seconds: (asset.thumbnailTimeMs ?? 1_000) / 1_000 })
            : t('creativeLibraryPreviewReady')
          : t('creativeLibraryPreviewUnavailable');

  return (
    <button
      ref={root}
      type="button"
      className="creative-library-card-preview"
      data-preview-state={state}
      aria-label={t('teamCatalogPreviewFor', { name: asset.name })}
      disabled={!onPreview}
      onClick={() => onPreview?.(asset)}
    >
      {thumbnailUrl && (
        <img
          className="creative-library-card-preview-media"
          src={thumbnailUrl}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setState('ready')}
          onError={fallBackToRangePreview}
        />
      )}
      {asset.category === 'video' && previewUrl && !thumbnailUrl && (
        <video
          ref={element => {
            video.current = element;
            element?.setAttribute('referrerpolicy', 'no-referrer');
          }}
          className="creative-library-card-preview-media"
          src={previewUrl}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          onLoadedMetadata={seekVideoFrame}
          onSeeked={() => setState('ready')}
          onError={markUnavailable}
        />
      )}
      {asset.category === 'image' && previewUrl && !thumbnailUrl && (
        <img
          className="creative-library-card-preview-media"
          src={previewUrl}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setState('ready')}
          onError={markUnavailable}
        />
      )}
      <span className="creative-library-card-preview-fallback" aria-hidden={state === 'ready'}>
        <span>{categoryGlyph(asset)}</span>
        <small>{fallbackLabel}</small>
      </span>
      {onPreview && (
        <span className="creative-library-card-preview-cta">{t('teamCatalogPreview')}</span>
      )}
    </button>
  );
}
