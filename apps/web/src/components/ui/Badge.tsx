import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { uiClasses, type UiColor, type UiSize, type UiVariant } from './types';

/**
 * Badge and Chip (021, T015).
 *
 * A Badge states a fact — "Connected", "Beta", "3 agents". A Chip carries a
 * value a person put there and can take back — a tag, a filter, an attached
 * account. The difference is not decorative: a chip is interactive and a badge
 * is not, and the product had them wearing each other's clothes in four places.
 */

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  color?: UiColor;
  variant?: Extract<UiVariant, 'solid' | 'soft' | 'subtle' | 'outline'>;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  leading?: ReactNode;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { color = 'neutral', variant = 'soft', size = 'sm', leading, className, children, ...props },
  ref
) {
  return (
    <span
      ref={ref}
      {...props}
      className={uiClasses('badge', { color, variant, size, className })}
    >
      {leading && (
        <span className="ui-badge-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      {children}
    </span>
  );
});

export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'onSelect'> {
  color?: UiColor;
  variant?: Extract<UiVariant, 'soft' | 'outline' | 'subtle'>;
  size?: Extract<UiSize, 'xs' | 'sm'>;
  /** A dot, an avatar, a colour swatch. */
  leading?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Present when the chip can be taken off; draws the × and names it. */
  onRemove?: () => void;
  /** The accessible name of that ×, e.g. "Remove tag #2". */
  removeLabel?: string;
  /** Makes the chip itself pressable — a filter chip, a picker option. */
  onSelect?: () => void;
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  {
    color = 'neutral',
    variant = 'soft',
    size = 'sm',
    leading,
    selected = false,
    disabled = false,
    onRemove,
    removeLabel,
    onSelect,
    className,
    children,
    ...props
  },
  ref
) {
  const body = (
    <>
      {leading && (
        <span className="ui-chip-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="ui-chip-label">{children}</span>
    </>
  );

  return (
    <span
      ref={ref}
      {...props}
      className={uiClasses('chip', {
        color,
        variant,
        size,
        states: { selected, disabled, removable: Boolean(onRemove) },
        className
      })}
    >
      {onSelect ? (
        <button
          type="button"
          className="ui-chip-press"
          aria-pressed={selected}
          disabled={disabled}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        body
      )}
      {onRemove && (
        <button
          type="button"
          className="ui-chip-remove"
          aria-label={removeLabel ?? 'Remove'}
          title={removeLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="m4.5 4.5 7 7m0-7-7 7"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.6"
            />
          </svg>
        </button>
      )}
    </span>
  );
});
