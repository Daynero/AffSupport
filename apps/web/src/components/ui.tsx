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
      className={`button button-${variant} ${className}`.trim()}
    >
      {loading && <Spinner small />}
      {children}
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
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
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

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const normalized = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <div
      className={`progress-track ${normalized === null ? 'is-indeterminate' : ''}`}
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
      <i aria-hidden="true" />
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
  const [position, setPosition] = useState({ left: 0, top: 0 });
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
      const top =
        rect.bottom + estimatedHeight + 8 > window.innerHeight
          ? Math.max(12, rect.top - estimatedHeight - 8)
          : rect.bottom + 8;
      setPosition({ left, top });
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
          <span id={id} role="tooltip" className="tooltip-popover" style={position}>
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
