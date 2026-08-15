import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

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
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>, commit = false) => {
    if (disabled) return;
    event.stopPropagation();
    const next = pointerValue(event);
    onChange(next);
    if (commit) onCommit?.(next);
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
  const percent = taskProgressPercent(value, max);

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    element.style.setProperty('--task-progress-position', `${percent}%`);
  }, [percent]);

  return (
    <div className={`team-task-progress-scale ${disabled ? 'is-disabled' : ''}`.trim()}>
      <div
        ref={track}
        className="team-task-progress-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} / ${max}`}
        onKeyDown={updateFromKeyboard}
        onPointerDown={event => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event);
        }}
        onPointerUp={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          updateFromPointer(event, true);
        }}
        onClick={event => event.stopPropagation()}
      >
        <span className="team-task-progress-knob" aria-hidden="true">
          {value}
        </span>
      </div>
    </div>
  );
}
