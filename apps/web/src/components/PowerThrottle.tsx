import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { POWER_LIMIT_MAX, POWER_LIMIT_MIN } from '@video-compressor/shared';
import { analytics } from '../analytics/service';
import { useI18n } from '../i18n';
import { usePower } from '../lib/power';
import { useSotyLoad } from '../lib/soty-load';
import { PowerLever } from './PowerLever';
import { PowerLoadMeter, useLoadMeter } from './PowerLoadMeter';
import { PowerReadout, PowerThrottleNotice } from './PowerReadout';
import { IconButton } from './ui/index';

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
  const { limitPercent, setLimit, status, watch, error, limitApplied } = usePower();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  // One reading for the button and for the panel's line, so they cannot disagree.
  const sotyLoad = useSotyLoad();
  const load = sotyLoad.load;
  const meter = useLoadMeter(load);

  const limited = limitPercent < POWER_LIMIT_MAX;
  const disabled = status === 'unsupported';
  const powerTravel = (limitPercent - POWER_LIMIT_MIN) / (POWER_LIMIT_MAX - POWER_LIMIT_MIN);
  // Purple at minimum, warming continuously through magenta/red into Soty
  // honey at full power. Keeping this on the parent makes every visual signal
  // share exactly the same live colour.
  const powerHue = 258 + powerTravel * 140;
  const powerLightness = 62 - powerTravel * 9;
  const powerStyle = {
    '--power-level-color': `hsl(${powerHue} 82% ${powerLightness}%)`,
    ...meter.style
  } as CSSProperties;

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
    <div className="power-throttle" ref={containerRef} style={powerStyle}>
      <IconButton
        ref={buttonRef}
        className="power-toggle"
        data-limited={limited ? 'true' : undefined}
        data-meter={meter.showing ? 'on' : undefined}
        label={t('powerControl')}
        title={
          load?.availability === 'ok' && meter.showing
            ? t('powerLoadTitle', {
                usage: [
                  t('powerLoadCpu', { percent: load.cpuPercent }),
                  ...(load.gpuPercent === null
                    ? []
                    : [t('powerLoadGpu', { percent: load.gpuPercent })])
                ].join(' · '),
                limit: limitPercent
              })
            : t('powerLimitAt', { percent: limitPercent })
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) analytics.track('power_panel_opened', {});
        }}
      >
        <PowerLoadMeter meter={meter} />
        <PowerIcon />
        {limited ? <span className="power-toggle__badge">{limitPercent}</span> : null}
      </IconButton>
      {open ? (
        <div className="power-panel" id={panelId} role="dialog" aria-label={t('powerControl')}>
          <div className="power-panel__heading">
            <p className="power-panel__title">{t('powerPanelTitle')}</p>
            <p
              className="power-panel__value"
              aria-label={t('powerLimitAt', { percent: limitPercent })}
            >
              <strong>{limitPercent}</strong>
              <span>%</span>
            </p>
          </div>
          <PowerLever
            value={limitPercent}
            disabled={disabled}
            onChange={percent => {
              setLimit(percent);
              analytics.track('power_limit_changed', { limit_percent: percent });
            }}
          />
          <PowerReadout sotyLoad={sotyLoad.supported ? { load, showing: meter.showing } : null} />
          <PowerThrottleNotice />
          {!limitApplied && !error ? (
            <p className="power-panel__pending">{t('powerLimitNotApplied')}</p>
          ) : null}
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
      width="19"
      height="19"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m13.1 2.5-8 11h6.4l-.6 8 8-11h-6.4l.6-8Z" />
    </svg>
  );
}
