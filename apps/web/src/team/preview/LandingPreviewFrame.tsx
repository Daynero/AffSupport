import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { TeamLandingValidationRecord } from '@video-compressor/shared';

export interface LandingPreviewView {
  kind: 'landing';
  operationId: string;
  url: string;
  sandbox: 'allow-scripts';
  warning: 'external_navigation_blocked' | null;
  screenshotUrl?: string | null;
  validation?: TeamLandingValidationRecord;
}

export function LandingPreviewFrame({ preview }: { preview: LandingPreviewView }) {
  const { t } = useI18n();
  const [fallback, setFallback] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const showFallback = () => setFallback(true);
    frame.addEventListener('error', showFallback);
    return () => frame.removeEventListener('error', showFallback);
  }, [preview.url]);
  return (
    <div className="team-landing-preview">
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
          ref={frameRef}
          title={t('teamPreviewLandingFrame')}
          src={preview.url}
          sandbox={preview.sandbox}
          referrerPolicy="no-referrer"
          onError={() => setFallback(true)}
        />
      )}
    </div>
  );
}
