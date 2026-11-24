import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The "?" beside a setting's name (docs/DESIGN.md: «Група = FieldLabel (назва +
 * «?»-тултіп) над контролом»).
 *
 * A setting explains itself in a tip rather than a paragraph under it, and the
 * tip has to work where a hover tip does not: pressed on a phone, focused from
 * the keyboard, pinned open while the person reads it. So it is a button that
 * owns a small portalled bubble, not the inventory's `Tooltip` (which hangs off
 * a control that already does something else).
 *
 * It was the pre-021 shim's `Tooltip`, which every tool screen imported from
 * the shim; it is the inventory's own since 070 (T035–T038), unchanged.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [interaction, setInteraction] = useState<TooltipInteractionState>({
    hovered: false,
    focused: false,
    pinned: false
  });
  const [position, setPosition] = useState({ left: 0, top: 0, arrowX: 0, side: 'bottom' });
  const popover = useRef<HTMLSpanElement>(null);
  const open = interaction.hovered || interaction.focused || interaction.pinned;
  const interact = (value: TooltipInteraction) =>
    setInteraction(current => tooltipInteraction(current, value));

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const update = () => {
      const rect = button.current!.getBoundingClientRect();
      // Measured, not assumed: the bubble is as wide as its words up to the stylesheet's
      // ceiling, and a guessed 280px put a long hint's right edge past the viewport.
      const bubble = popover.current;
      const width = Math.min(bubble?.offsetWidth || 280, window.innerWidth - 24);
      const left = Math.min(
        window.innerWidth - width - 12,
        Math.max(12, rect.left + rect.width / 2 - width / 2)
      );
      const estimatedHeight = bubble?.offsetHeight || 88;
      const side = rect.bottom + estimatedHeight + 8 > window.innerHeight ? 'top' : 'bottom';
      const top = side === 'top' ? Math.max(12, rect.top - estimatedHeight - 8) : rect.bottom + 8;
      const arrowX = Math.min(width - 14, Math.max(14, rect.left + rect.width / 2 - left));
      setPosition({ left, top, arrowX, side });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (button.current?.contains(event.target as Node)) return;
      interact('outside');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      interact('escape');
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span className="tooltip-anchor">
      <button
        ref={button}
        type="button"
        className="tooltip-button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => interact('hover-in')}
        onMouseLeave={() => interact('hover-out')}
        onFocus={() => interact('focus')}
        onBlur={() => interact('blur')}
        onClick={() => interact('toggle')}
      >
        ?
      </button>
      {open &&
        createPortal(
          <span
            ref={popover}
            id={id}
            role="tooltip"
            className="tooltip-popover"
            data-side={position.side}
            style={
              {
                left: position.left,
                top: position.top,
                '--tooltip-arrow-x': `${position.arrowX}px`
              } as CSSProperties
            }
          >
            {children}
          </span>,
          document.body
        )}
    </span>
  );
}

export interface TooltipInteractionState {
  hovered: boolean;
  focused: boolean;
  pinned: boolean;
}

export type TooltipInteraction =
  'hover-in' | 'hover-out' | 'focus' | 'blur' | 'toggle' | 'escape' | 'outside';

export function tooltipInteraction(
  state: TooltipInteractionState,
  interaction: TooltipInteraction
): TooltipInteractionState {
  if (interaction === 'hover-in') return { ...state, hovered: true };
  if (interaction === 'hover-out') return { ...state, hovered: false };
  if (interaction === 'focus') return { ...state, focused: true };
  if (interaction === 'blur') return { ...state, focused: false };
  if (interaction === 'toggle') return { ...state, pinned: !state.pinned };
  return { hovered: false, focused: false, pinned: false };
}
