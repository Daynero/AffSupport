import { useId, useState, type CSSProperties } from 'react';
import type { LandingAsset } from '@video-compressor/shared';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { Modal } from '../components/Modal';
import { Spinner, type Translate } from '../components/ui';
import { landingPreviewPath } from '../api/client';
import { useSubresourceUrl } from '../api/useSubresourceUrl';

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
  const [position, setPosition] = useState(50);
  const [loaded, setLoaded] = useState({ before: false, after: false });
  const [failed, setFailed] = useState(false);
  const preview = asset.preview;
  const comparison = preview?.comparison === true;
  // Ticketed, so the session token is not in an <img loading="lazy" decoding="async" src> that ends up in a
  // referrer or a log. Null until the ticket arrives, which the loading state
  // below already covers.
  const beforeUrl = useSubresourceUrl(landingPreviewPath(jobId, asset.id, 'before'), {
    variant: 'full'
  });
  const afterUrl = useSubresourceUrl(landingPreviewPath(jobId, asset.id, 'after'), {
    variant: 'full'
  });

  const ready = loaded.before && (!comparison || loaded.after) && !failed;
  const saving = asset.savedPercent ?? 0;
  const style = { '--compare-position': `${position}%` } as CSSProperties;

  return (
    <Modal
      bare
      backdropClassName="landing-compare-backdrop"
      className={`landing-compare-modal ${comparison ? 'is-comparison' : 'is-single'}`}
      labelledBy={titleId}
      onClose={onClose}
      initialFocus=".landing-compare-close"
      returnFocus={returnFocus}
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
                loading="lazy"
                decoding="async"
                className="landing-compare-image landing-compare-after"
                src={afterUrl ?? ''}
                alt=""
                draggable={false}
                onLoad={() => setLoaded(value => ({ ...value, after: true }))}
                onError={() => setFailed(true)}
              />
              <div className="landing-compare-before-layer" aria-hidden="true">
                <img
                  loading="lazy"
                  decoding="async"
                  className="landing-compare-image landing-compare-before"
                  src={beforeUrl ?? ''}
                  alt=""
                  draggable={false}
                  onLoad={() => setLoaded(value => ({ ...value, before: true }))}
                  onError={() => setFailed(true)}
                />
              </div>
            </>
          ) : (
            <img
              loading="lazy"
              decoding="async"
              className="landing-compare-image landing-compare-single"
              src={beforeUrl ?? ''}
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
    </Modal>
  );
}
