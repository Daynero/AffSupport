import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '../../components/ui/index';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 180;

/**
 * What is behind a count, shown on the count (024).
 *
 * "2 attachments", "3 tasks" said how many and nothing else: seeing which meant opening the thing
 * or leaving the page. Resting the pointer on the count — or focusing it — opens a small surface
 * with what it counts, the way Linear previews an issue under a link. The surface stays while the
 * pointer moves onto it, so what is in it can be pressed.
 *
 * `children` is rendered only while open, so whatever it loads is loaded on demand.
 */
export function HoverPeek({
  trigger,
  label,
  className,
  children
}: {
  trigger: ReactNode;
  label: string;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (next: boolean, delay: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, []);
  useEffect(() => clear, []);

  return (
    <span
      ref={anchor}
      className="team-hover-peek"
      onPointerEnter={event => {
        if (event.pointerType === 'mouse') later(true, OPEN_DELAY_MS);
      }}
      onPointerLeave={event => {
        if (event.pointerType === 'mouse') later(false, CLOSE_DELAY_MS);
      }}
      onFocus={() => later(true, 0)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          later(false, CLOSE_DELAY_MS);
        }
      }}
    >
      {trigger}
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        placement="bottom-start"
        frequent
        label={label}
        className={['team-hover-peek-surface', className].filter(Boolean).join(' ')}
      >
        <div
          onFocus={clear}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              later(false, CLOSE_DELAY_MS);
            }
          }}
          onPointerEnter={clear}
          onPointerLeave={event => {
            if (event.pointerType === 'mouse') later(false, CLOSE_DELAY_MS);
          }}
        >
          {open && children(close)}
        </div>
      </Popover>
    </span>
  );
}
