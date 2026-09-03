import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { LandingAsset } from '@video-compressor/shared';
import { formatSize } from '../format';
import type { Language } from '../i18n';
import { Modal } from '../components/Modal';
import { Button, Spinner, type Translate } from '../components/ui';
import { landingPreviewPath } from '../api/client';
import { useSubresourceUrl } from '../api/useSubresourceUrl';

/**
 * How long a preview may take before the wait becomes an answer.
 *
 * A spinner is a promise that something is coming. Left alone it is a promise nothing keeps:
 * the images can fail in ways that fire no event at all, and a person watching a circle turn
 * has no way to tell a slow machine from a broken one. Twelve seconds is well past the
 * slowest honest decode of a full-size preview on this hardware.
 */
const PREVIEW_TIMEOUT_MS = 12_000;

/** The nudge that shows the divider is draggable, in milliseconds after it appears. */
const NUDGE_AT_MS = 260;
const NUDGE_BACK_MS = 820;
/** How far the divider travels on its own. Far enough to be seen, short enough to be a hint. */
const NUDGE_TO = 62;

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
  const [timedOut, setTimedOut] = useState(false);
  /** Bumped by "try again": it rebuilds the URLs, so the browser fetches rather than replays. */
  const [attempt, setAttempt] = useState(0);
  const [touched, setTouched] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);

  const preview = asset.preview;
  const comparison = preview?.comparison === true;
  const ratio =
    preview && preview.width && preview.height ? preview.width / preview.height : null;

  /*
   * Ticketed, so the session token never lands in an `<img src>` — which is the one URL a
   * browser is guaranteed to put in a referrer and a log.
   *
   * Three answers, not two: undefined while the ticket is being asked for, null when it was
   * refused. A refusal used to be indistinguishable from a slow one, and it renders an `<img>`
   * with an empty `src`, which fires neither `load` nor `error`.
   */
  const beforePath = landingPreviewPath(jobId, asset.id, 'before');
  const afterPath = landingPreviewPath(jobId, asset.id, 'after');
  const full = useMemo(() => ({ variant: 'full', attempt: String(attempt) }), [attempt]);
  const thumb = useMemo(() => ({ variant: 'thumbnail' }), []);
  const beforeUrl = useSubresourceUrl(beforePath, full);
  const afterUrl = useSubresourceUrl(afterPath, full);
  /* The thumbnail the card already fetched: the browser has it, so it paints immediately and
     the frame holds a blurred version of the picture instead of a hole. */
  const placeholderUrl = useSubresourceUrl(comparison ? afterPath : beforePath, thumb);

  const refused = beforeUrl === null || (comparison && afterUrl === null);
  const ready = loaded.before && (!comparison || loaded.after) && !failed;
  const broken = failed || refused || timedOut;
  const saving = asset.savedPercent ?? 0;

  // Every attempt starts its own clock, and a preview that arrives stops it.
  useEffect(() => {
    if (ready || broken) return;
    const timer = window.setTimeout(() => setTimedOut(true), PREVIEW_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [ready, broken, attempt]);

  /*
   * The divider moves once, by itself, the moment the picture appears.
   *
   * "Drag the divider" is a sentence somebody has to read and believe. Half a second of the
   * thing actually moving says it without words, and says it to people who never read the
   * line above the image.
   */
  useEffect(() => {
    if (!ready || !comparison || touched) return;
    const out = window.setTimeout(() => {
      setNudging(true);
      setPosition(NUDGE_TO);
    }, NUDGE_AT_MS);
    const back = window.setTimeout(() => {
      setPosition(50);
      window.setTimeout(() => setNudging(false), 500);
    }, NUDGE_BACK_MS);
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(back);
    };
  }, [ready, comparison, touched]);

  const retry = useCallback(() => {
    setLoaded({ before: false, after: false });
    setFailed(false);
    setTimedOut(false);
    setAttempt(value => value + 1);
  }, []);

  const move = useCallback((value: number) => {
    setTouched(true);
    setNudging(false);
    setPosition(value);
  }, []);

  /* Panning while zoomed. The two never fight over the same drag: at actual size the range
     input stops taking pointers, so the surface pans and the divider moves with the arrows. */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!zoomed) return;
    dragFrom.current = { x: event.clientX, y: event.clientY, pan };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    setPan({ x: from.pan.x + (event.clientX - from.x), y: from.pan.y + (event.clientY - from.y) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleZoom = () => {
    setZoomed(value => !value);
    setPan({ x: 0, y: 0 });
  };

  const style = {
    '--compare-position': `${position}%`,
    '--compare-pan-x': `${pan.x}px`,
    '--compare-pan-y': `${pan.y}px`,
    ...(ratio ? { '--compare-ratio': String(ratio) } : {})
  } as CSSProperties;

  const image = (side: 'before' | 'after', src: string | null | undefined) => (
    <img
      key={`${side}-${attempt}`}
      decoding="async"
      className={`landing-compare-image landing-compare-${side}`}
      src={src ?? ''}
      alt=""
      draggable={false}
      onLoad={() => setLoaded(value => ({ ...value, [side]: true }))}
      onError={() => setFailed(true)}
    />
  );

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
        <div className="landing-compare-heading">
          <h2 id={titleId}>
            {t(comparison ? 'landingPreviewTitle' : 'landingPreviewTitleSingle', {
              name: asset.fileName
            })}
          </h2>
          {/* The instruction is needed once. After the first drag it is a line of text taking
              up room above the thing it was explaining. */}
          <p>
            {broken
              ? null
              : zoomed
                ? t('landingPreviewPanHint')
                : touched
                  ? null
                  : t(comparison ? 'landingPreviewHint' : 'landingPreviewHintSingle')}
          </p>
        </div>
        <div className="landing-compare-tools">
          {ready && (
            <button
              type="button"
              className="landing-compare-zoom"
              aria-pressed={zoomed}
              aria-label={t(zoomed ? 'landingPreviewZoomOut' : 'landingPreviewZoomIn')}
              data-tip={t(zoomed ? 'landingPreviewZoomOut' : 'landingPreviewZoomIn')}
              onClick={toggleZoom}
            >
              {zoomed ? (
                <Minimize2 size={18} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Maximize2 size={18} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className="landing-compare-close"
            aria-label={t('landingPreviewClose')}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div className="landing-compare-viewport" aria-busy={!ready && !broken}>
        <div
          className={[
            'landing-compare-stage',
            comparison ? 'is-comparison' : 'is-single',
            ready ? 'is-ready' : '',
            ratio ? 'has-ratio' : '',
            nudging ? 'is-nudging' : '',
            zoomed ? 'is-zoomed' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={style}
          onDoubleClick={comparison && !zoomed ? () => move(50) : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* Under everything, and only until the real thing is decoded. */}
          {!ready && !broken && placeholderUrl && (
            <img
              className="landing-compare-image landing-compare-placeholder"
              src={placeholderUrl}
              alt=""
              draggable={false}
              aria-hidden="true"
            />
          )}
          {comparison ? (
            <>
              {image('after', afterUrl)}
              <div className="landing-compare-before-layer" aria-hidden="true">
                {image('before', beforeUrl)}
              </div>
            </>
          ) : (
            image('before', beforeUrl)
          )}
          {ready && comparison && (
            <>
              <span className="landing-compare-label is-before">{t('landingPreviewBefore')}</span>
              <span className="landing-compare-label is-after">{t('landingPreviewAfter')}</span>
              {/* The divider stays at actual size — that is where a comparison is finally
                  worth making. What changes is who gets the drag: the surface pans, and the
                  divider is moved with the arrow keys, which the range still answers to
                  because it is focusable even when it is not taking pointers. */}
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
                onChange={event => move(Number(event.target.value))}
              />
            </>
          )}
        </div>
        {!ready && !broken && (
          <div className="landing-preview-loading">
            <Spinner />
            <span>{t('landingPreviewLoading')}</span>
          </div>
        )}
        {broken && (
          <div className="landing-preview-loading is-error" role="alert">
            <span>{t(timedOut && !failed && !refused ? 'landingPreviewSlow' : 'landingPreviewUnavailable')}</span>
            <Button variant="secondary" onClick={retry}>
              {t('landingPreviewRetry')}
            </Button>
          </div>
        )}
      </div>

      {/* What the comparison was opened to find out, in the order it is wanted: how much was
          saved, then the two figures that produced it. It used to read as three equal
          fragments, with the answer last. */}
      <footer className={`landing-compare-footer ${comparison ? 'is-comparison' : 'is-single'}`}>
        {comparison ? (
          <>
            {saving > 0 && (
              <strong className="landing-compare-saving">
                {t('landingSaved', { value: saving })}
              </strong>
            )}
            <span className="landing-compare-sizes">
              {formatSize(asset.originalSize, language)}
              <i aria-hidden="true">→</i>
              {formatSize(asset.optimizedSize, language)}
            </span>
          </>
        ) : (
          <span className="landing-compare-sizes">
            {t('landingPreviewUnchanged')}
            <strong>{formatSize(asset.originalSize, language)}</strong>
          </span>
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
