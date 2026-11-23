import { useRef, useState, type KeyboardEvent } from 'react';
import { useMove } from 'react-aria/useMove';

/**
 * The edge between two panes that a person can move (070, R5, FR-006).
 *
 * The explorer's folder tree was `minmax(200px, 280px)` and nothing else: a
 * long folder name was cut, and the only way to read it was to hover each one.
 * Finder, Drive and Explorer all let the edge move. This is that edge, as a
 * window splitter is described in the ARIA practices: a focusable
 * `role="separator"` that reports its value, its bounds and its orientation.
 *
 * - **Pointer and touch** — `useMove` from React Aria, so a drag that leaves the
 *   handle keeps going and a touch does not also scroll the page.
 * - **Keyboard** — the arrows move by `step` (16 px), Home and End go to the
 *   bounds. The arrows that match the orientation do the work: left/right for
 *   an edge between two columns, up/down for an edge between two rows.
 * - **Motion** — none of its own. The pane follows the pointer frame by frame,
 *   which is a position, not an animation; the handle's hover tint uses the
 *   `--motion-fast` token, which the token layer collapses under reduced motion.
 *
 * It is controlled: the value is the size of the pane the edge belongs to
 * (`side="start"` — the pane before it, which grows as the edge moves right or
 * down; `side="end"` — the pane after it), and storing it is the caller's job.
 */
export type SplitterProps = {
  /** The pane's size in pixels. */
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Called once when a drag or a key press is over, with the value it ended on. */
  onChangeEnd?: (value: number) => void;
  /** What the edge resizes, for a reader: "Folder tree width". */
  label: string;
  /**
   * `vertical` — an upright edge between two columns (the default);
   * `horizontal` — a lying edge between two rows.
   */
  orientation?: 'vertical' | 'horizontal';
  /** Which pane the value measures: the one before the edge, or after it. */
  side?: 'start' | 'end';
  /** One key press, in pixels. */
  step?: number;
  className?: string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function Splitter({
  value,
  min,
  max,
  onChange,
  onChangeEnd,
  label,
  orientation = 'vertical',
  side = 'start',
  step = 16,
  className
}: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  /* The drag is measured from where it started, not added up from rounded
     values: a pane that sat at a bound would otherwise lag the pointer by
     every pixel the pointer had travelled past it. */
  const start = useRef(value);
  const travelled = useRef(0);
  const last = useRef(value);
  const sign = side === 'start' ? 1 : -1;

  const { moveProps } = useMove({
    onMoveStart: () => {
      start.current = value;
      travelled.current = 0;
      last.current = value;
      setDragging(true);
    },
    onMove: event => {
      if (event.pointerType === 'keyboard') return;
      travelled.current += orientation === 'vertical' ? event.deltaX : event.deltaY;
      const next = Math.round(clamp(start.current + sign * travelled.current, min, max));
      if (next !== last.current) {
        last.current = next;
        onChange(next);
      }
    },
    onMoveEnd: event => {
      setDragging(false);
      if (event.pointerType !== 'keyboard') onChangeEnd?.(last.current);
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    let next: number | null = null;
    if (event.key === grow) next = value + sign * step;
    else if (event.key === shrink) next = value - sign * step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    const bounded = clamp(next, min, max);
    if (bounded !== value) onChange(bounded);
    onChangeEnd?.(bounded);
  };

  // React Aria's own arrow handling moves one pixel per press; the edge takes
  // `step` instead, so only the pointer half of `useMove` is used.
  const { onKeyDown: _ariaKeys, ...pointerProps } = moveProps;
  void _ariaKeys;

  return (
    <div
      {...pointerProps}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={[
        'ui-splitter',
        `ui-splitter--${orientation}`,
        dragging ? 'is-dragging' : '',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    />
  );
}
