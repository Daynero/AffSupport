import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { uiClasses, type UiColor, type UiSize, type UiVariant } from './types';

/**
 * The one button (021, T014).
 *
 * The product had seven: `.button-primary`, `.button-secondary`, `.button-ghost`,
 * `.button-danger`, `.team-agent-run-add`, `.team-accounts-fold-all`,
 * `.team-empty-action` — each an outline pill with its own height, radius and
 * hover, invented where it was needed. They were never different kinds of
 * button; they were the same button with nobody to ask for it.
 *
 * `color` says what the button means, `variant` how loudly, `size` how much
 * room. The legacy `variant="primary" | "danger" | …` spelling still works and
 * maps onto the pair, so the sixty files that import this keep compiling while
 * their screens migrate.
 */

/** The five names the pre-021 codebase uses, kept working through one mapping. */
type LegacyVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

const LEGACY: Record<LegacyVariant, { color: UiColor; variant: UiVariant }> = {
  // Honey, filled — the one action a surface exists for.
  primary: { color: 'primary', variant: 'solid' },
  // A bordered neutral button: the product's workhorse.
  secondary: { color: 'neutral', variant: 'outline' },
  ghost: { color: 'neutral', variant: 'ghost' },
  // Soft rather than solid: a destructive action is de-emphasised beside the
  // safe one (docs/DESIGN-PRINCIPLES.md), and this is what `.button-danger`
  // already did.
  danger: { color: 'error', variant: 'soft' },
  success: { color: 'success', variant: 'soft' }
};

function isLegacy(value: string | undefined): value is LegacyVariant {
  return value !== undefined && value in LEGACY;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  color?: UiColor;
  variant?: UiVariant | LegacyVariant;
  size?: UiSize;
  /** Replaces the label with a spinner and keeps the button's width. */
  loading?: boolean;
  /** Full width of its container — a dialog's confirm, a card's call to action. */
  block?: boolean;
  /** Equal padding on all sides: an icon with no label. */
  square?: boolean;
  /** Drawn before the label. */
  leading?: ReactNode;
  /** Drawn after the label. */
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    color,
    variant,
    size = 'md',
    loading = false,
    block = false,
    square = false,
    leading,
    trailing,
    className,
    disabled,
    children,
    ...props
  },
  ref
) {
  const legacy = isLegacy(variant) ? LEGACY[variant] : null;
  const resolvedColor = color ?? legacy?.color ?? 'neutral';
  const resolvedVariant = legacy?.variant ?? ((variant as UiVariant | undefined) ?? 'solid');

  return (
    <button
      ref={ref}
      // A bare <button> inside a form submits it. Most buttons in this product
      // are not a form's submit, so the safe default is stated and a caller
      // that wants a submit asks for one.
      type={props.type ?? 'button'}
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={uiClasses('button', {
        color: resolvedColor,
        variant: resolvedVariant,
        size,
        states: { loading, block, square, disabled: disabled || loading },
        className
      })}
    >
      {leading && (
        <span className="ui-button-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      {children !== undefined && children !== null && children !== false && (
        <span className="ui-button-label">{children}</span>
      )}
      {trailing && (
        <span className="ui-button-trailing" aria-hidden="true">
          {trailing}
        </span>
      )}
      {loading && (
        <span className="ui-button-spinner" aria-hidden="true">
          <span className="ui-spinner" />
        </span>
      )}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  /** The control's name. Required: an icon alone names nothing. */
  label: string;
  color?: UiColor;
  variant?: UiVariant;
  size?: UiSize;
  loading?: boolean;
  /** `aria-pressed` for a toggle; left alone for a plain action. */
  pressed?: boolean;
  children: ReactNode;
}

/**
 * An icon with no room for its label.
 *
 * docs/DESIGN.md: 20px is the comfortable icon, and if the space is tight the
 * plate grows — the icon never shrinks. So the sizes here change the plate,
 * not the glyph.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    color = 'neutral',
    variant = 'ghost',
    size = 'md',
    loading = false,
    pressed,
    title = label,
    className,
    disabled,
    children,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      {...props}
      disabled={disabled || loading}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      title={title}
      className={uiClasses('icon-button', {
        color,
        variant,
        size,
        states: { loading, pressed, disabled: disabled || loading },
        className
      })}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : children}
    </button>
  );
});
