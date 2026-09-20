import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { uiClasses, type UiColor, type UiSize } from './types';

/**
 * Feedback (021, T021, T024).
 *
 * Empty, Skeleton, Progress and Tooltip — the four things every screen needs
 * and every screen invented. An empty list is where a product either tells you
 * what to do next or leaves you looking at nothing; the product had both.
 */

export interface EmptyProps {
  icon?: ReactNode;
  title: ReactNode;
  /**
   * What the title is, in the document's outline. A state inside a panel is a
   * strong line; a state that *is* the screen — an unavailable space reached
   * from a shared link — is that screen's heading, and a reader navigating by
   * headings needs to find it.
   */
  titleAs?: 'strong' | 'h1' | 'h2' | 'h3';
  /** One sentence. If it needs two, the first one is not doing its job. */
  description?: ReactNode;
  /** The control that fills the emptiness, where one exists (FR-021). */
  action?: ReactNode;
  size?: Extract<UiSize, 'sm' | 'md' | 'lg'>;
  className?: string;
}

export function Empty({
  icon,
  title,
  titleAs: Title = 'strong',
  description,
  action,
  size = 'md',
  className
}: EmptyProps) {
  return (
    <div className={uiClasses('empty', { size, className })} role="status">
      {icon && (
        <span className="ui-empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <Title className="ui-empty-title">{title}</Title>
      {description && <p className="ui-empty-description prose">{description}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The shape of what is coming. A skeleton that does not match its content
   * moves the page when the content lands, which is the thing it exists to
   * prevent.
   */
  shape?: 'text' | 'block' | 'row' | 'tile' | 'circle';
  /** How many of them — a list of rows, a grid of tiles. */
  count?: number;
  /** What is loading, for a reader who cannot see the shimmer. */
  label?: string;
}

export function Skeleton({ shape = 'text', count = 1, label, className, ...props }: SkeletonProps) {
  return (
    <div
      {...props}
      className={uiClasses('skeleton-group', { className })}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {label && <span className="visually-hidden">{label}</span>}
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={`ui-skeleton ui-skeleton--${shape}`} aria-hidden="true" />
      ))}
    </div>
  );
}

export interface ProgressProps {
  /** 0–100, or absent for work whose length is unknown. */
  value?: number;
  color?: UiColor;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  label?: string;
  /**
   * What the percentage *means*, said in words: "£120 raised of £400".
   * A screen reader announces this instead of "37%", which is the difference
   * between a number and an answer.
   */
  valueText?: string;
  /**
   * The bar is decoration and something else already says the number — a
   * button whose own label reads "raised £120 of £400". A second progressbar
   * inside that button would announce the same fact twice.
   */
  decorative?: boolean;
  /** A ring instead of a bar — the TOTP countdown, a small inline job. */
  circular?: boolean;
  className?: string;
}

export function Progress({
  value,
  color = 'primary',
  size = 'md',
  label,
  valueText,
  decorative = false,
  circular = false,
  className
}: ProgressProps) {
  const indeterminate = value === undefined || Number.isNaN(value);
  const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div
      className={uiClasses(circular ? 'progress-ring' : 'progress', {
        color,
        size,
        states: { indeterminate },
        className
      })}
      role={decorative ? undefined : 'progressbar'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      aria-valuemin={decorative ? undefined : 0}
      aria-valuemax={decorative ? undefined : 100}
      aria-valuenow={decorative || indeterminate ? undefined : Math.round(clamped)}
      aria-valuetext={decorative ? undefined : valueText}
      style={indeterminate ? undefined : ({ '--ui-progress-ratio': clamped / 100 } as never)}
    >
      <span className="ui-progress-fill" aria-hidden="true" />
    </div>
  );
}

/** A spinner with no bar behind it — inside a button, beside a chip. */
export function Spinner({ size = 'sm', label }: { size?: 'sm' | 'md'; label?: string }) {
  return (
    <span
      className={`ui-spinner ui-spinner--${size}`}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * Tooltip with a delay group.
 *
 * `docs/DESIGN-PRINCIPLES.md`: the first tooltip of a group waits, so a pointer
 * crossing the row does not set off a cascade; its neighbours open at once and
 * without animation, because by then the reader is reading tooltips.
 */
let groupOpenUntil = 0;

export interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  /** ms before the first tooltip of a group appears. */
  delay?: number;
  placement?: 'top' | 'bottom';
  className?: string;
}

export function Tooltip({
  label,
  children,
  delay = 400,
  placement = 'top',
  className
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const show = () => {
    const withinGroup = Date.now() < groupOpenUntil;
    setInstant(withinGroup);
    if (withinGroup) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };

  const hide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (open) groupOpenUntil = Date.now() + 600;
    setOpen(false);
  };

  return (
    <span
      className={uiClasses('tooltip-anchor', { className })}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={`ui-tooltip ui-tooltip--${placement}${instant ? ' is-instant' : ''}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
