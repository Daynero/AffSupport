import { Button as HeroButton, type ButtonProps as HeroButtonProps } from '@heroui/react/button';
import { useCallback, useRef, type MouseEvent, type ReactNode, type Ref } from 'react';
import {
  heroSize,
  heroVariant,
  uiClasses,
  useNativeAttributes,
  type UiColor,
  type UiSize,
  type UiVariant
} from './types';

/**
 * The one button (021 T014, rebuilt on HeroUI in 024).
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
 *
 * ## What changed underneath, and what did not
 *
 * The element is now React Aria's, by way of HeroUI. That is where the press
 * handling, the disabled semantics, the hover and focus-visible states and the
 * pending flag come from — behaviour this product had been re-deriving with
 * `:active` rules and `onMouseDown` guards.
 *
 * What did **not** change is who decides how it looks. The `ui-*` classes are
 * still the appearance, and `components.css` still holds every one of the seven
 * colours times six variants times five sizes. It is imported into the `soty`
 * layer, above the library, so this product's 38px control stays 38px.
 *
 * `onClick` keeps working: React Aria accepts it as an alias for `onPress`.
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

/**
 * One ref for the component's own use and one for the caller's.
 *
 * The adapters need a handle on the node — React Aria will not carry `title`
 * there — while a caller may still want the node for a popover anchor or a
 * focus call. Merging is three lines and the alternative is choosing between
 * them.
 */
function useMergedRef(
  own: React.RefObject<HTMLButtonElement | null>,
  forwarded: Ref<HTMLButtonElement> | undefined
) {
  return useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded, own]
  );
}

/**
 * The props of a `<button>`, minus the ones React Aria owns.
 *
 * `color` is ours. `onClick` survives as React Aria's alias for `onPress`, but
 * the mouse-event family it replaces (`onMouseDown`, `onMouseUp`) does not: a
 * press is not a mouse-down, and a control that listened for one behaved
 * differently under touch and keyboard. Nothing in the product used them on a
 * Button.
 */
export interface ButtonProps {
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
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  id?: string;
  autoFocus?: boolean;
  tabIndex?: number;
  form?: string;
  /** React Aria accepts this as an alias for its own press event. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: boolean | 'menu' | 'listbox' | 'dialog' | 'grid' | 'tree' | 'true' | 'false';
  'aria-controls'?: string;
  'aria-pressed'?: boolean;
  'aria-current'?: boolean | 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false';
  'data-testid'?: string;
}

export function Button({
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
  type = 'button',
  title,
  onClick,
  ref: forwarded,
  ...props
}: ButtonProps) {
  const node = useRef<HTMLButtonElement>(null);
  const ref = useMergedRef(node, forwarded);
  useNativeAttributes(node, { title, 'aria-busy': loading ? 'true' : undefined });
  const legacy = isLegacy(variant) ? LEGACY[variant] : null;
  const resolvedColor = color ?? legacy?.color ?? 'neutral';
  const resolvedVariant = legacy?.variant ?? (variant as UiVariant | undefined) ?? 'solid';

  return (
    <HeroButton
      {...props}
      ref={ref}
      onClick={onClick as HeroButtonProps['onClick']}
      // A bare button inside a form submits it. Most buttons in this product are
      // not a form's submit, so the safe default is stated and a caller that
      // wants a submit asks for one.
      type={type}
      isDisabled={disabled || loading}
      isPending={loading || undefined}
      variant={heroVariant(resolvedVariant, resolvedColor)}
      size={heroSize(size)}
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
    </HeroButton>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'block' | 'square'> {
  /** The control's name. Required: an icon alone names nothing. */
  label: string;
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
export function IconButton({
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
  type = 'button',
  onClick,
  ref: forwarded,
  ...props
}: IconButtonProps) {
  const node = useRef<HTMLButtonElement>(null);
  const ref = useMergedRef(node, forwarded);
  useNativeAttributes(node, { title, 'aria-busy': loading ? 'true' : undefined });
  return (
    <HeroButton
      {...props}
      ref={ref}
      onClick={onClick as HeroButtonProps['onClick']}
      type={type}
      isDisabled={disabled || loading}
      isPending={loading || undefined}
      isIconOnly
      variant={heroVariant(variant as UiVariant, color)}
      size={heroSize(size)}
      aria-label={label}
      aria-pressed={pressed}
      className={uiClasses('icon-button', {
        color,
        variant: variant as UiVariant,
        size,
        states: { loading, pressed, disabled: disabled || loading },
        className
      })}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : children}
    </HeroButton>
  );
}
