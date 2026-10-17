import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';

export function moveDurationSelection(
  initial: readonly [number, number],
  delta: number
): [number, number] {
  const bounded = Math.max(1 - initial[0], Math.min(60 - initial[1], delta));
  return [initial[0] + bounded, initial[1] + bounded];
}

/** Local drag state keeps expensive launch previews out of pointer movement. */
export function DurationSlider({
  value,
  range,
  disabled,
  label,
  unit,
  onCommit,
  modeAction
}: {
  value: readonly [number, number];
  range: boolean;
  disabled?: boolean;
  label: string;
  unit: string;
  modeAction?: ReactNode;
  onCommit: (value: readonly [number, number]) => void;
}) {
  const [live, setLive] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLDivElement>(null);
  const actionSide = useRef<'left' | 'right'>('right');
  const centerRef = useRef(0);
  const [actionOffset, setActionOffset] = useState(0);
  const liveRef = useRef(value);
  const track = useRef<HTMLDivElement>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const selection = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => () => animations.current.forEach(animation => animation.cancel()), []);
  const previous = useRef({ range, value });
  const drag = useRef<{
    id: number;
    x: number;
    width: number;
    value: readonly [number, number];
    part: number | 'range';
  } | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const valueRef = useRef(value);
  valueRef.current = value;
  const finishDrag = (cancel = false, pointerId?: number) => {
    const active = drag.current;
    if (!active || (pointerId !== undefined && active.id !== pointerId)) return;
    // Clear first: releasing capture can synchronously fire lostpointercapture.
    drag.current = null;
    if (track.current?.hasPointerCapture?.(active.id))
      track.current.releasePointerCapture(active.id);
    if (cancel) {
      liveRef.current = valueRef.current;
      setLive(valueRef.current);
    } else commitRef.current(liveRef.current);
  };
  const finishRef = useRef(finishDrag);
  finishRef.current = finishDrag;
  useEffect(() => {
    const up = (event: PointerEvent) => finishRef.current(false, event.pointerId);
    const cancel = (event: PointerEvent) => finishRef.current(true, event.pointerId);
    const blur = () => finishRef.current();
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', blur);
      drag.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    setLive(value);
    liveRef.current = value;
    if (
      previous.current.range !== range &&
      typeof matchMedia === 'function' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      animations.current.forEach(animation => animation.cancel());
      animations.current = [];
      const width = track.current?.getBoundingClientRect().width ?? 0;
      const old = previous.current;
      const duration =
        Number.parseFloat(getComputedStyle(track.current!).getPropertyValue('--motion-base')) ||
        220;
      const easing = getComputedStyle(track.current!).getPropertyValue('--ease-out-curve').trim();
      thumbs.current.forEach((thumb, index) => {
        const from = old.range ? old.value[index] : old.value[0];
        const to = range ? value[index] : value[0];
        const animation = thumb?.animate?.(
          [
            { translate: `${((from - to) / 59) * width}px 0`, opacity: 1 },
            { translate: '0px 0', opacity: !range && index === 1 ? 0 : 1 }
          ],
          { duration, easing: easing || 'linear' }
        );
        if (animation) animations.current.push(animation);
      });
      const expansion = selection.current?.animate?.(
        [{ transform: 'translateY(-50%) scaleX(0)' }, { transform: 'translateY(-50%) scaleX(1)' }],
        { duration, easing: easing || 'linear' }
      );
      if (expansion) animations.current.push(expansion);
    }
    previous.current = { range, value };
  }, [value[0], value[1], range]);
  const update = (next: readonly [number, number]) => {
    liveRef.current = next;
    setLive(next);
  };
  const percent = (n: number) => `${((n - 1) / 59) * 100}%`;
  const center = range ? (live[0] + live[1]) / 2 : live[0];
  centerRef.current = center;
  useLayoutEffect(() => {
    const positionAction = () => {
      if (!root.current || !badge.current || !action.current) return;
      const width = root.current.clientWidth;
      const badgeWidth = badge.current.offsetWidth;
      const actionWidth = action.current.offsetWidth;
      if (width <= 0 || actionWidth <= 0) return;
      const gap =
        Number.parseFloat(getComputedStyle(root.current).getPropertyValue('--space-3')) || 12;
      const clampInset =
        Number.parseFloat(getComputedStyle(root.current).getPropertyValue('--space-5')) * 2 || 40;
      const badgeCenter = Math.max(
        clampInset,
        Math.min(width - clampInset, ((centerRef.current - 1) / 59) * width)
      );
      const leftClearance = badgeCenter - badgeWidth / 2;
      const rightClearance = width - badgeCenter - badgeWidth / 2;
      const currentClearance = actionSide.current === 'right' ? rightClearance : leftClearance;
      const otherClearance = actionSide.current === 'right' ? leftClearance : rightClearance;
      // Only move on collision, and only to a safer corner. This hysteresis
      // avoids bouncing when a narrow viewport cannot fit either corner.
      if (currentClearance < actionWidth + gap && otherClearance > currentClearance + gap) {
        actionSide.current = actionSide.current === 'right' ? 'left' : 'right';
      }
      setActionOffset(actionSide.current === 'right' ? Math.max(0, width - actionWidth) : 0);
    };
    positionAction();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(positionAction);
    for (const element of [root.current, badge.current, action.current])
      if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [center, modeAction]);
  return (
    <div ref={root} className={`duration-slider ${range ? 'is-range' : 'is-exact'}`}>
      {modeAction && (
        <div
          ref={action}
          className="duration-slider-mode"
          style={{ transform: `translateX(${actionOffset}px)` }}
        >
          {modeAction}
        </div>
      )}
      <div
        ref={badge}
        className="duration-slider-value"
        style={{
          left: `clamp(calc(var(--space-5) * 2), ${percent(center)}, calc(100% - calc(var(--space-5) * 2)))`
        }}
      >
        {range ? `${live[0]}–${live[1]}` : live[0]} {unit}
      </div>
      <div
        ref={track}
        className="duration-slider-track"
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const part = (event.target as HTMLElement).closest<HTMLElement>('[data-part]')?.dataset
            .part;
          const minute = Math.max(
            1,
            Math.min(60, Math.round(1 + ((event.clientX - bounds.left) / bounds.width) * 59))
          );
          const selected =
            part === 'range' && range
              ? 'range'
              : part === '1' && range
                ? 1
                : part === '0'
                  ? 0
                  : range && Math.abs(minute - live[1]) < Math.abs(minute - live[0])
                    ? 1
                    : 0;
          if (selected !== 'range') thumbs.current[selected]?.focus();
          const initial = [...live] as [number, number];
          if (part === undefined) {
            initial[selected === 1 ? 1 : 0] =
              selected === 1
                ? Math.max(initial[0], minute)
                : range
                  ? Math.min(initial[1], minute)
                  : minute;
            update(initial);
          }
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            width: bounds.width,
            value: initial,
            part: selected
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const active = drag.current;
          if (!active || active.id !== event.pointerId) return;
          // Recover even if the browser/OS dropped pointerup outside the window.
          if (event.pointerType !== 'touch' && (event.buttons & 1) === 0) {
            finishDrag(false, event.pointerId);
            return;
          }
          const delta = Math.round(((event.clientX - active.x) / active.width) * 59);
          if (active.part === 'range') update(moveDurationSelection(active.value, delta));
          else {
            const next: [number, number] = [...active.value];
            next[active.part] = Math.max(
              active.part === 1 ? next[0] : 1,
              Math.min(active.part === 0 && range ? next[1] : 60, active.value[active.part] + delta)
            );
            update(next);
          }
        }}
        onPointerUp={event => finishDrag(false, event.pointerId)}
        onPointerCancel={event => finishDrag(true, event.pointerId)}
        onLostPointerCapture={event => finishDrag(false, event.pointerId)}
      >
        {range && (
          <div
            ref={selection}
            className="duration-slider-selection"
            data-part="range"
            style={{ left: percent(live[0]), width: `${((live[1] - live[0]) / 59) * 100}%` }}
          />
        )}
        {[0, 1].map(index => (
          <button
            key={index}
            ref={node => {
              thumbs.current[index] = node;
            }}
            type="button"
            role="slider"
            data-part={index}
            className="duration-slider-thumb"
            disabled={disabled}
            aria-label={`${label}${range ? ` ${index + 1}` : ''}`}
            aria-valuemin={index === 1 ? live[0] : 1}
            aria-valuemax={index === 0 && range ? live[1] : 60}
            aria-valuenow={range ? live[index] : live[0]}
            aria-valuetext={`${range ? live[index] : live[0]} ${unit}`}
            aria-hidden={(!range && index === 1) || undefined}
            tabIndex={!range && index === 1 ? -1 : 0}
            style={{ left: percent(range ? live[index] : live[0]) }}
            onKeyDown={event => {
              const changes: Record<string, number> = {
                ArrowRight: 1,
                ArrowUp: 1,
                ArrowLeft: -1,
                ArrowDown: -1,
                PageUp: 5,
                PageDown: -5
              };
              if (!(event.key in changes) && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const next: [number, number] = [...live];
              const low = index === 1 ? next[0] : 1;
              const high = index === 0 && range ? next[1] : 60;
              next[index] =
                event.key === 'Home'
                  ? low
                  : event.key === 'End'
                    ? high
                    : Math.max(low, Math.min(high, next[index] + changes[event.key]));
              update(next);
              onCommit(next);
            }}
          >
            <GripVertical size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="duration-slider-ticks" aria-hidden="true">
        {[1, 5, 10, 20, 30, 40, 50, 60].map(n => (
          <span key={n} style={{ left: percent(n) }}>
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}
