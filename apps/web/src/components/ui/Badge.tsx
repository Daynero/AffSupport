import { X } from 'lucide-react';
import { Chip as HeroChip } from '@heroui/react/chip';
import type { HTMLAttributes, ReactNode } from 'react';
import { uiClasses, type UiColor, type UiSize, type UiVariant } from './types';

/**
 * Badge and Chip (021 T015, on HeroUI in 024).
 *
 * A Badge states a fact — "Connected", "Beta", "3 agents". A Chip carries a
 * value a person put there and can take back — a tag, a filter, an attached
 * account. The difference is not decorative: a chip is interactive and a badge
 * is not, and the product had them wearing each other's clothes in four places.
 *
 * Both are the library's `Chip` underneath, which is the pill this product
 * draws; the library's own `Badge` is the little count that sits on the corner
 * of something else, which is a different object this product does not have.
 *
 * The press and the remove control stay this product's own buttons. The
 * library's `TagGroup` is the right home for a *group* of removable tags — one
 * keyboard walk across all of them — and that is where the task labels belong;
 * a chip rendered on its own beside unrelated things is not a group, and
 * wrapping each one in a group of one would be a lie told to assistive
 * technology.
 */

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  color?: UiColor;
  variant?: Extract<UiVariant, 'solid' | 'soft' | 'subtle' | 'outline'>;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  leading?: ReactNode;
}

export function Badge({
  color = 'neutral',
  variant = 'soft',
  size = 'sm',
  leading,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <HeroChip {...props} className={uiClasses('badge', { color, variant, size, className })}>
      {leading && (
        <span className="ui-badge-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      {children}
    </HeroChip>
  );
}

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

export function Chip({
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
}: ChipProps) {
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
    <HeroChip
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
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </HeroChip>
  );
}
