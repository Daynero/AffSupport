import {
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from 'react';
import { POWER_LIMIT_MAX, POWER_LIMIT_MIN } from '@video-compressor/shared';
import { useI18n } from '../i18n';

/**
 * A vertical throttle, drawn as an aircraft thrust lever: full travel forward
 * is full power, pulled back is the minimum. The marked scale is what makes the
 * position readable at a glance without opening anything.
 *
 * It is a slider to assistive technology, not just to the eye — the whole
 * control is useless to a keyboard or screen-reader user otherwise.
 */

const SCALE_MARKS = [100, 80, 60, 40, 20];
const STEP = 1;
const PAGE_STEP = 10;

export function PowerLever({
  value,
  disabled = false,
  onChange
}: {
  value: number;
  disabled?: boolean;
  onChange: (percent: number) => void;
}) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement | null>(null);

  const clamp = (percent: number) =>
    Math.min(POWER_LIMIT_MAX, Math.max(POWER_LIMIT_MIN, Math.round(percent)));

  /** Maps a pointer position on the track to a limit; the top is full power. */
  const percentFromPointer = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) return null;
    const bounds = track.getBoundingClientRect();
    if (bounds.height === 0) return null;
    const travelled = 1 - (clientY - bounds.top) / bounds.height;
    return clamp(POWER_LIMIT_MIN + travelled * (POWER_LIMIT_MAX - POWER_LIMIT_MIN));
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // Capture so a drag that leaves the track keeps controlling the lever —
    // otherwise the handle sticks the moment the pointer slips sideways.
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = percentFromPointer(event.clientY);
    if (next !== null) onChange(next);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = percentFromPointer(event.clientY);
    if (next !== null) onChange(next);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const moves: Record<string, number | 'min' | 'max'> = {
      ArrowUp: STEP,
      ArrowRight: STEP,
      ArrowDown: -STEP,
      ArrowLeft: -STEP,
      PageUp: PAGE_STEP,
      PageDown: -PAGE_STEP,
      Home: 'min',
      End: 'max'
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    if (move === 'min') onChange(POWER_LIMIT_MIN);
    else if (move === 'max') onChange(POWER_LIMIT_MAX);
    else onChange(clamp(value + move));
  };

  // The one computed value that has to be inline: everything else is a class.
  const travel = (value - POWER_LIMIT_MIN) / (POWER_LIMIT_MAX - POWER_LIMIT_MIN);

  return (
    <div className="power-lever">
      <div className="power-lever__scale" aria-hidden="true">
        {SCALE_MARKS.map(mark => (
          <span key={mark} className="power-lever__mark">
            {t('powerScaleMark', { percent: mark })}
          </span>
        ))}
      </div>
      <div
        ref={trackRef}
        className="power-lever__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-orientation="vertical"
        aria-valuemin={POWER_LIMIT_MIN}
        aria-valuemax={POWER_LIMIT_MAX}
        aria-valuenow={value}
        aria-valuetext={`${value}%`}
        aria-label={t('powerLeverLabel')}
        aria-disabled={disabled}
        style={{ '--power-travel': String(travel) } as CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <span className="power-lever__fill" aria-hidden="true" />
        <span className="power-lever__handle" aria-hidden="true">
          <span className="power-lever__grip" />
        </span>
      </div>
    </div>
  );
}
