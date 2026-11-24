/**
 * The pre-021 shared controls, plus the inventory they are being replaced by.
 *
 * `Button`, `IconButton`, `SegmentedControl`, `Checkbox`, `ProgressBar`,
 * `Spinner`, `StatusBadge`, `Tooltip` and `Collapse` below are the originals:
 * about sixty modules import them from this path, and they keep working
 * untouched until their screen migrates.
 *
 * Everything the inventory adds — Badge, Chip, Card, Alert, the form field
 * family, the overlays, the data surfaces and the five state patterns — is
 * re-exported from `components/ui/`, so a screen being migrated can reach the
 * new components from the import it already has. A name that exists in both
 * places (Button, Checkbox, Tooltip, …) resolves to the original here; a
 * migrated screen imports those from `components/ui/index` directly, which is
 * how the two generations stay apart without a flag day.
 *
 * See specs/021-design-system-redesign/contracts/components.md.
 */

export {
  Accordion,
  Alert,
  Badge,
  Breadcrumb,
  Card,
  Chip,
  ConfirmDialog,
  Drawer,
  DropdownMenu,
  Empty,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  InputNumber,
  InputTags,
  LoadingState,
  Link as UiLink,
  Pagination,
  PermissionState,
  Popover,
  Progress,
  RadioGroup,
  Select,
  SelectionBar,
  Separator,
  Skeleton,
  Slider,
  Switch,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tabs,
  Textarea,
  Timeline,
  Tree,
  User,
  UI_COLORS,
  UI_SIZES,
  UI_VARIANTS,
  fillRatio,
  uiClasses
} from './ui/index';
export type {
  AlertProps,
  BadgeProps,
  CardProps,
  CardRole,
  ChipProps,
  ConfirmDialogProps,
  EmptyStateProps,
  ErrorStateProps,
  InputProps,
  LoadingStateProps,
  MenuItem,
  PermissionStateProps,
  SelectProps,
  SelectionBarProps,
  TabItem,
  TreeNode,
  UiColor,
  UiSize,
  UiVariant
} from './ui/index';

import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';

export type { Translate } from '../i18n';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
/**
 * Forwards its ref: a surface that opens an editor in place of the button
 * needs the button back to return focus to when the editor closes.
 */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }
>(function Button(
  { variant = 'secondary', loading = false, className = '', disabled, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      {...props}
      disabled={disabled || loading}
      className={`soty-button button-${variant} ${loading ? 'is-loading' : ''} ${className}`.trim()}
    >
      {children}
      {loading && (
        <span className="button-spinner" aria-hidden="true">
          <Spinner small />
        </span>
      )}
    </button>
  );
});

export function IconButton({
  label,
  children,
  title = label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    // A bare `<button>` inside a form submits it. An icon button is never the
    // form's submit — it is a remove, a copy, a toggle — so the default is the
    // safe one; a caller that wants a submit says so.
    <button
      type="button"
      {...props}
      className={`icon-button ${props.className ?? ''}`.trim()}
      aria-label={label}
      title={title}
    >
      {children}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  // The active indicator slides between options instead of blinking
  // in place. Measured from the DOM so option widths can differ per
  // language without the container jumping.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const active = element.querySelector<HTMLButtonElement>('button.is-active');
      if (!active) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, options.map(option => option.label).join('|')]);

  return (
    <div
      ref={container}
      className={`segmented ${indicator ? '' : 'no-indicator'}`.trim()}
      role="radiogroup"
      aria-label={label}
    >
      {indicator && (
        <span
          className="segmented-indicator"
          aria-hidden="true"
          style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
        />
      )}
      {options.map((option, index) => (
        <button
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          /* A roving tab stop: the group is one stop, not one per option.
             Without it, Tab walked through every choice — so a form with three
             of these cost nine presses to cross, and Tab moved *within* a
             control where a radio group's own convention is that arrows do. */
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={event => {
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (step === 0 || disabled) return;
            event.preventDefault();
            // Wraps, which is what a radio group does: from the last option,
            // one more press returns to the first rather than doing nothing.
            const next = options[(index + step + options.length) % options.length];
            onChange(next.value);
            const buttons = event.currentTarget.parentElement?.querySelectorAll('button');
            buttons?.[(index + step + options.length) % options.length]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  label,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={`soty-checkbox ${className}`.trim()}>
      <input {...props} type="checkbox" />
      <span className="checkbox-mark" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function ProgressBar({
  value,
  label,
  active = false
}: {
  value: number | null;
  label: string;
  active?: boolean;
}) {
  const normalized = value === null ? null : Math.min(100, Math.max(0, value));
  const flowing = active && normalized !== null && normalized < 100;
  return (
    <div
      className={`progress-track ${normalized === null ? 'is-indeterminate' : ''} ${
        flowing ? 'is-flowing' : ''
      }`.trim()}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized === null ? undefined : Math.round(normalized)}
    >
      <span
        style={
          normalized === null
            ? undefined
            : ({ '--progress-ratio': normalized / 100 } as CSSProperties)
        }
      />
    </div>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  return <span className={`soty-spinner ${small ? 'spinner-small' : ''}`} aria-hidden="true" />;
}

export { SotyDots, SotyLoader, TranscriptionLoader } from './SotyLoader';
export { StatusBadge } from './StatusBadge';

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
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
              } as React.CSSProperties
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

/** Expand/collapse wrapper that keeps content mounted and animates the
 * grid row track, so blocks appear without layout jumps. */
export function Collapse({
  open,
  fast = false,
  className = '',
  children
}: {
  open: boolean;
  fast?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`collapse ${fast ? 'collapse-fast' : ''} ${open ? 'is-open' : ''} ${className}`.trim()}
      aria-hidden={open ? undefined : true}
    >
      <div className="collapse-body">{children}</div>
    </div>
  );
}
