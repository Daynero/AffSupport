import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

/**
 * One picto that is on or off (070, phase 8б): the single toggle of docs/DESIGN.md's picto
 * groups, as an inventory control.
 *
 * `RadioGroup variant="pictos"` chooses one of several and `IconButton` presses; neither is a
 * toggle that stays pressable while it cannot act. A catalog's video, links or R2 copy may be
 * locked for a reason the reader has to be able to ask for — the plate is then `unavailable`:
 * announced as disabled, still focusable, still pressable, and the press is the caller's to
 * answer (with the reason, not with the change). It can also show how far a job behind it has
 * come, as a fill rising from the bottom (`fill`, 0–1).
 *
 * The element is a plain `<button>`, so a `Tooltip asChild` and a roving `tabIndex` reach it as
 * they reach any button; every native attribute (`data-*` included) passes through.
 */
export interface PictoToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-pressed' | 'aria-disabled' | 'aria-busy' | 'disabled' | 'type'
> {
  /** On or off: `aria-pressed`, and the selected plate. */
  pressed: boolean;
  /** Cannot act right now, for a reason the press should explain; still focusable and pressable. */
  unavailable?: boolean;
  /** A change is on its way. */
  busy?: boolean;
  /** How far the job behind the plate has come, 0–1, drawn as a fill from the bottom. */
  fill?: number;
  children: ReactNode;
}

export const PictoToggle = forwardRef<HTMLButtonElement, PictoToggleProps>(function PictoToggle(
  { pressed, unavailable = false, busy = false, fill, className, style, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      aria-pressed={pressed}
      aria-disabled={unavailable || undefined}
      aria-busy={busy || undefined}
      className={['ui-picto-toggle', pressed ? 'is-selected' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={
        fill === undefined
          ? style
          : ({ ...style, '--ui-picto-fill': Math.min(1, Math.max(0, fill)) } as CSSProperties)
      }
    >
      {children}
    </button>
  );
});
