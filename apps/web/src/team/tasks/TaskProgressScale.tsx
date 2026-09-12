import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function taskProgressPercent(value: number, max: number): number {
  return clamp((value / Math.max(max, 1)) * 100, 0, 100);
}

export function TaskProgressScale({
  value,
  max,
  disabled = false,
  onChange,
  onCommit,
  label
}: {
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  label: string;
}) {
  const track = useRef<HTMLDivElement | null>(null);
  const pointerValue = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return value;
    const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    return Math.round(ratio * Math.max(max, 1));
  };
  /** A drag is in progress, so its end has something to save. */
  const dragging = useRef(false);
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.stopPropagation();
    onChange(pointerValue(event));
  };
  /**
   * Ends a gesture by saving what the knob shows.
   *
   * Two things used to lose a value here. A cancelled pointer — a scroll taking
   * over the gesture, a window losing focus, a touch the browser reclaims —
   * fires `pointercancel` instead of `pointerup`, and with no handler the drag
   * simply stopped: the knob stayed where it had been pulled and nothing was
   * ever sent. And the commit itself was behind the `disabled` check, so a
   * control that became busy mid-gesture swallowed the release too.
   *
   * A gesture that really happened is honoured either way. What it saves is the
   * value on screen rather than the pointer's last position, because that is
   * what the person saw themselves choose.
   */
  const endGesture = (event: PointerEvent<HTMLDivElement>, next: number) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
    onChange(next);
    onCommit?.(next);
  };
  const updateFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + 1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const normalized = clamp(next, 0, Math.max(max, 1));
    onChange(normalized);
    onCommit?.(normalized);
  };
  /*
   * What is drawn is the value the scale can hold, never the one it was given.
   * Lowering a task's maximum leaves the old number behind for as long as it
   * takes the change to reach a card, and a knob pinned at the end of a
   * ten-step scale reading "90" is worse than a stale number: it is a number
   * that cannot be true.
   */
  const shown = clamp(value, 0, Math.max(max, 1));
  const percent = taskProgressPercent(shown, max);

  return (
    <div className={`team-task-progress-scale ${disabled ? 'is-disabled' : ''}`.trim()}>
      <div
        ref={track}
        className="team-task-progress-track"
        /* Written on the element React renders, not from an effect: an effect
           runs after paint, so every pointer move drew the knob at its previous
           spot and it trailed the cursor by a frame. */
        style={{ '--task-progress-position': `${percent}%` } as CSSProperties}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={`${shown} / ${max}`}
        onKeyDown={updateFromKeyboard}
        onPointerDown={event => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          updateFromPointer(event);
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event);
        }}
        onPointerUp={event => endGesture(event, disabled ? shown : pointerValue(event))}
        onPointerCancel={event => endGesture(event, shown)}
        onClick={event => event.stopPropagation()}
      >
        <span className="team-task-progress-knob" aria-hidden="true">
          {shown}
        </span>
      </div>
    </div>
  );
}
