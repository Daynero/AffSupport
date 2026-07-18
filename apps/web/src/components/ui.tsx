import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import type { JobStatus } from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';

export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  variant = 'secondary',
  loading = false,
  className = '',
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`button button-${variant} ${loading ? 'is-loading' : ''} ${className}`.trim()}
    >
      {children}
      {loading && (
        <span className="button-spinner" aria-hidden="true">
          <Spinner small />
        </span>
      )}
    </button>
  );
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      {...props}
      className={`icon-button ${props.className ?? ''}`.trim()}
      aria-label={label}
      title={label}
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
      {options.map(option => (
        <button
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'is-active' : ''}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
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
    <label className={`checkbox ${className}`.trim()}>
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
      <span style={normalized === null ? undefined : { width: `${normalized}%` }} />
    </div>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  return <span className={`spinner ${small ? 'spinner-small' : ''}`} aria-hidden="true" />;
}

/** Wishly conversion loader: three ribbons calmly compress into one.
 * Pure SVG + CSS transforms, sized for the status area. */
export function WishlyLoader({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="wishly-loader"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="ribbon-top"
        x="3"
        y="4"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        className="ribbon-center"
        x="3"
        y="8.7"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        className="ribbon-bottom"
        x="3"
        y="13.4"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
    </svg>
  );
}

/** Calm staggered dots for the estimation state — intentionally lighter
 * than the conversion loader. */
export function WishlyDots() {
  return (
    <span className="wishly-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function StatusBadge({ status, t }: { status: JobStatus; t: Translate }) {
  const keys: Record<JobStatus, TranslationKey> = {
    analyzing: 'statusAnalyzing',
    ready: 'statusReady',
    queued: 'statusQueued',
    processing: 'statusProcessing',
    completed: 'statusCompleted',
    failed: 'statusFailed',
    cancelled: 'statusCancelled',
    interrupted: 'statusInterrupted'
  };
  return (
    <span className={`status-badge status-${status}`}>
      {status === 'processing' ? (
        <WishlyLoader size={13} />
      ) : status === 'completed' ? (
        <svg
          className="status-check"
          width="11"
          height="11"
          viewBox="0 0 12 12"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M2.5 6.5 5 9 9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <i aria-hidden="true" />
      )}
      {t(keys[status])}
    </span>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [interaction, setInteraction] = useState<TooltipInteractionState>({
    hovered: false,
    focused: false,
    pinned: false
  });
  const [position, setPosition] = useState({ left: 0, top: 0, arrowX: 0, side: 'bottom' });
  const open = interaction.hovered || interaction.focused || interaction.pinned;
  const interact = (value: TooltipInteraction) =>
    setInteraction(current => tooltipInteraction(current, value));

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const update = () => {
      const rect = button.current!.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 24);
      const left = Math.min(
        window.innerWidth - width - 12,
        Math.max(12, rect.left + rect.width / 2 - width / 2)
      );
      const estimatedHeight = 88;
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
