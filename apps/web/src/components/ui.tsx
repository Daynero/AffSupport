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
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode
} from 'react';

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

export { HelpTip as Tooltip, tooltipInteraction } from './ui/HelpTip';
export type { TooltipInteraction, TooltipInteractionState } from './ui/HelpTip';

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
