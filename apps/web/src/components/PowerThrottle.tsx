import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { POWER_LIMIT_MAX } from '@video-compressor/shared';
import { analytics } from '../analytics/service';
import { useI18n } from '../i18n';
import { usePower } from '../lib/power';
import { PowerLever } from './PowerLever';
import { PowerReadout, PowerThrottleNotice } from './PowerReadout';

/**
 * The header control: a power icon that opens the throttle.
 *
 * The icon carries the current setting even while closed. Without that, a limit
 * set weeks ago reads as "Soty has become slow" rather than "I told Soty to use
 * less of this machine" — and there would be nothing on screen to connect the
 * two.
 */
export function PowerThrottle() {
  const { t } = useI18n();
  const { limitPercent, setLimit, status, watch, error } = usePower();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  const limited = limitPercent < POWER_LIMIT_MAX;
  const disabled = status === 'unsupported';

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Measurement runs only while the panel is open, on both sides of the wire.
  useEffect(() => {
    if (!open) return;
    return watch();
  }, [open, watch]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  return (
    <div className="power-throttle" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="power-toggle"
        data-limited={limited ? 'true' : undefined}
        aria-label={t('powerControl')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        title={t('powerLimitAt', { percent: limitPercent })}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) analytics.track('power_panel_opened', {});
        }}
      >
        <PowerIcon />
        {limited ? <span className="power-toggle__badge">{limitPercent}</span> : null}
      </button>
      {open ? (
        <div className="power-panel" id={panelId} role="dialog" aria-label={t('powerControl')}>
          <p className="power-panel__title">{t('powerPanelTitle')}</p>
          <p className="power-panel__value">{t('powerLimitAt', { percent: limitPercent })}</p>
          <PowerLever
            value={limitPercent}
            disabled={disabled}
            onChange={percent => {
              setLimit(percent);
              analytics.track('power_limit_changed', { limit_percent: percent });
            }}
          />
          <PowerReadout />
          <PowerThrottleNotice />
          {error ? <p className="power-panel__error">{t('powerLimitFailed')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PowerIcon() {
  return (
    <svg
      className="power-toggle__icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M12 3v9" />
      <path d="M7.5 6.3a7.5 7.5 0 1 0 9 0" />
    </svg>
  );
}
