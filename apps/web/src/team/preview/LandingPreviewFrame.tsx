import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import type { LandingViewerPreset, TeamLandingValidationRecord } from '@video-compressor/shared';

export interface LandingPreviewView {
  kind: 'landing';
  operationId: string;
  url: string;
  sandbox: 'allow-scripts';
  warning: 'external_navigation_blocked' | null;
  screenshotUrl?: string | null;
  validation?: TeamLandingValidationRecord;
}

export function LandingPreviewFrame({
  preview,
  preset
}: {
  preview: LandingPreviewView;
  preset?: LandingViewerPreset;
}) {
  const { t } = useI18n();
  const previewKey = `${preview.url}\u0000${preview.screenshotUrl ?? ''}`;
  const [fallbackForPreview, setFallbackForPreview] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fallback = fallbackForPreview === previewKey;
  const showFallback = useCallback(() => setFallbackForPreview(previewKey), [previewKey]);
  const attachFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      frameRef.current?.removeEventListener('error', showFallback);
      frameRef.current = frame;
      frame?.addEventListener('error', showFallback);
    },
    [showFallback]
  );

  useEffect(
    () => () => frameRef.current?.removeEventListener('error', showFallback),
    [showFallback]
  );
  return (
    <div
      className="team-landing-preview"
      data-device={preset?.device}
      data-color-scheme={preset?.colorScheme}
      style={
        preset ? ({ '--landing-viewer-zoom': String(preset.zoom) } as CSSProperties) : undefined
      }
    >
      {preview.warning === 'external_navigation_blocked' && (
        <p className="team-preview-safety-note">{t('teamPreviewExternalBlocked')}</p>
      )}
      {fallback && preview.screenshotUrl ? (
        <img
          className="team-landing-preview-fallback"
          src={preview.screenshotUrl}
          alt={t('teamPreviewSafeScreenshot')}
          referrerPolicy="no-referrer"
        />
      ) : (
        <iframe
          ref={attachFrame}
          title={t('teamPreviewLandingFrame')}
          src={preview.url}
          sandbox={preview.sandbox}
          referrerPolicy="no-referrer"
          onError={showFallback}
        />
      )}
    </div>
  );
}
