import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { LandingAsset } from '@video-compressor/shared';
import { landingPreviewUrl } from '../api/client';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { Spinner, type Translate } from '../components/ui';

export function ImageCompareModal({
  jobId,
  asset,
  language,
  returnFocus,
  onClose,
  t
}: {
  jobId: string;
  asset: LandingAsset;
  language: Language;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  t: Translate;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const [loaded, setLoaded] = useState({ before: false, after: false });
  const [failed, setFailed] = useState(false);
  const preview = asset.preview;
  const comparison = preview?.comparison === true;
  const beforeUrl = useMemo(() => landingPreviewUrl(jobId, asset.id, 'before'), [jobId, asset.id]);
  const afterUrl = useMemo(() => landingPreviewUrl(jobId, asset.id, 'after'), [jobId, asset.id]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLButtonElement>('.landing-compare-close')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

  const ready = loaded.before && (!comparison || loaded.after) && !failed;
  const saving = asset.savedPercent ?? 0;
  const style = { '--compare-position': `${position}%` } as CSSProperties;

  return createPortal(
    <div
      className="landing-compare-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={`landing-compare-modal ${comparison ? 'is-comparison' : 'is-single'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="landing-compare-header">
          <div>
            <h2 id={titleId}>
              {t(comparison ? 'landingPreviewTitle' : 'landingPreviewTitleSingle', {
                name: asset.fileName
              })}
            </h2>
            <p>{t(comparison ? 'landingPreviewHint' : 'landingPreviewHintSingle')}</p>
          </div>
          <button
            type="button"
            className="landing-compare-close"
            aria-label={t('landingPreviewClose')}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="landing-compare-viewport" aria-busy={!ready}>
          <div
            className={`landing-compare-stage ${comparison ? 'is-comparison' : 'is-single'} ${ready ? 'is-ready' : ''}`}
            style={style}
            onDoubleClick={comparison ? () => setPosition(50) : undefined}
          >
            {comparison ? (
              <>
                <img
                  className="landing-compare-image landing-compare-after"
                  src={afterUrl}
                  alt=""
                  draggable={false}
                  onLoad={() => setLoaded(value => ({ ...value, after: true }))}
                  onError={() => setFailed(true)}
                />
                <div className="landing-compare-before-layer" aria-hidden="true">
                  <img
                    className="landing-compare-image landing-compare-before"
                    src={beforeUrl}
                    alt=""
                    draggable={false}
                    onLoad={() => setLoaded(value => ({ ...value, before: true }))}
                    onError={() => setFailed(true)}
                  />
                </div>
              </>
            ) : (
              <img
                className="landing-compare-image landing-compare-single"
                src={beforeUrl}
                alt=""
                draggable={false}
                onLoad={() => setLoaded(value => ({ ...value, before: true }))}
                onError={() => setFailed(true)}
              />
            )}
            {ready && comparison && (
              <>
                <span className="landing-compare-label is-before">{t('landingPreviewBefore')}</span>
                <span className="landing-compare-label is-after">{t('landingPreviewAfter')}</span>
                <span className="landing-compare-divider" aria-hidden="true">
                  <i>‹</i>
                  <i>›</i>
                </span>
                <input
                  className="landing-compare-range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={position}
                  aria-label={t('landingPreviewSlider')}
                  aria-valuetext={`${position}%`}
                  onChange={event => setPosition(Number(event.target.value))}
                />
              </>
            )}
          </div>
          {!ready && !failed && (
            <div className="landing-preview-loading">
              <Spinner />
              <span>{t('landingPreviewLoading')}</span>
            </div>
          )}
          {failed && (
            <div className="landing-preview-loading is-error" role="alert">
              <span>{t('landingPreviewUnavailable')}</span>
            </div>
          )}
        </div>

        <footer className={`landing-compare-footer ${comparison ? 'is-comparison' : 'is-single'}`}>
          {comparison ? (
            <>
              <div>
                <span>{t('landingPreviewBefore')}</span>
                <strong>{formatSize(asset.originalSize, language)}</strong>
              </div>
              <span className="landing-compare-arrow" aria-hidden="true">
                →
              </span>
              <div>
                <span>{t('landingPreviewAfter')}</span>
                <strong>{formatSize(asset.optimizedSize, language)}</strong>
              </div>
              {saving > 0 && (
                <strong className="landing-compare-saving">
                  {t('landingSaved', { value: saving })}
                </strong>
              )}
            </>
          ) : (
            <div>
              <span>{t('landingPreviewUnchanged')}</span>
              <strong>{formatSize(asset.originalSize, language)}</strong>
            </div>
          )}
          {preview && preview.width !== null && preview.height !== null && (
            <span className="landing-compare-dimensions">
              {preview.width}×{preview.height}
            </span>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
