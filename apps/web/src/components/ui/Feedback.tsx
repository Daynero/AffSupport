import { OVERLAY_OPEN_EVENT, tooltipAnchorAllowed } from '../../lib/overlayTips';
import { mergeProps, mergeRefs } from '@react-aria/utils';
import { Tooltip as HeroTooltip } from '@heroui/react/tooltip';
import {
  forwardRef,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useState,
  useRef,
  useMemo,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  type ReactNode,
  type ReactElement,
  type Ref,
  type SyntheticEvent
} from 'react';
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
 * Tooltip with a delay group (021 T024, rebuilt on HeroUI in 024).
 *
 * `docs/DESIGN-PRINCIPLES.md`: the first tooltip of a group waits, so a pointer
 * crossing the row does not set off a cascade; its neighbours open at once and
 * without animation, because by then the reader is reading tooltips.
 *
 * That rule used to be a module-level `groupOpenUntil` timestamp and a pair of
 * `setTimeout`s. React Aria implements the same behaviour as a global warmup
 * timer, which is what `shouldSkipAnimation` is named after — so the hand-rolled
 * version is gone and the rule it encoded is kept.
 *
 * The anchor stays a `<span>` this product styles, because a tooltip's trigger
 * is often a non-focusable glyph and the layouts around it are written against
 * `.ui-tooltip-anchor`.
 */
export interface TooltipProps {
  /** Temporarily suspend tooltips while their control is being changed. */
  disabled?: boolean;
  /** Attach directly to an existing control without a second interactive wrapper. */
  asChild?: boolean;
  label: ReactNode;
  children: ReactNode;
  /** ms before the first tooltip of a group appears. */
  delay?: number;
  placement?: 'top' | 'bottom';
  className?: string;
}

type TooltipTriggerProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };

/** HeroUI supplies its positioning ref through render props; preserve the child's ref as well. */
function TooltipAnchor({
  triggerProps,
  children,
  asChild,
  className,
  dismiss,
  anchorRef
}: {
  triggerProps: TooltipTriggerProps;
  children: ReactNode;
  asChild: boolean;
  className?: string;
  dismiss: () => void;
  anchorRef: Ref<HTMLElement>;
}) {
  const child =
    asChild && isValidElement(children) ? (children as ReactElement<TooltipTriggerProps>) : null;
  const childRef = child?.props.ref;
  const ref = useMemo(
    () => mergeRefs(triggerProps.ref, childRef, anchorRef),
    [triggerProps.ref, childRef, anchorRef]
  );
  const props = mergeProps(triggerProps, child?.props ?? {}, {
    onPointerDown: dismiss,
    onClick: dismiss,
    onKeyDown: dismiss
  });
  if (child) return cloneElement(child, { ...props, ref });
  return (
    <span {...props} ref={ref} className={uiClasses('tooltip-anchor', { className })}>
      {children}
    </span>
  );
}

export function Tooltip({
  label,
  children,
  delay = 400,
  placement = 'top',
  className,
  asChild = false,
  disabled = false
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    window.addEventListener(OVERLAY_OPEN_EVENT, dismiss);
    return () => window.removeEventListener(OVERLAY_OPEN_EVENT, dismiss);
  }, [dismiss]);
  useEffect(() => {
    if (!open) return;
    const observer = new MutationObserver(() => {
      if (!anchor.current || !tooltipAnchorAllowed(anchor.current)) dismiss();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, dismiss]);
  return (
    <HeroTooltip
      delay={delay}
      closeDelay={0}
      shouldSkipAnimation
      isOpen={open && !disabled}
      isDisabled={disabled}
      onOpenChange={next =>
        setOpen(
          next && !disabled && Boolean(anchor.current && tooltipAnchorAllowed(anchor.current))
        )
      }
    >
      <HeroTooltip.Trigger
        render={props => (
          <TooltipAnchor
            triggerProps={props}
            asChild={asChild}
            className={className}
            dismiss={dismiss}
            anchorRef={anchor}
          >
            {children}
          </TooltipAnchor>
        )}
      />
      {open && !disabled && anchor.current?.isConnected && (
        <HeroTooltip.Content
          placement={placement}
          className={`ui-tooltip ui-tooltip--${placement}`}
        >
          {label}
        </HeroTooltip.Content>
      )}
    </HeroTooltip>
  );
}

/**
 * A picture that arrives softly (owner, 2026-10-10).
 *
 * The box it sits in is the holder — it keeps its size and its muted ground —
 * and the picture fades in over it once it has decoded, rather than snapping
 * in half-painted. A cached one fades too: it still replaces a holder that was
 * on screen a moment ago, and a snap there is the flicker this exists to stop.
 */
export const FadeImage = forwardRef<HTMLImageElement, ImgHTMLAttributes<HTMLImageElement>>(
  function FadeImage({ className, onLoad, src, ...props }, forwarded) {
    /** The address that has decoded; a new address fades in again. */
    const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
    /**
     * The address the holder has been painted for. A cached picture decodes before the first
     * frame, and a style that is already final when first computed has nothing to fade from —
     * so it waits for one painted frame at the holder.
     */
    const [paintedFor, setPaintedFor] = useState<string | undefined>(undefined);
    useEffect(() => {
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setPaintedFor(src));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }, [src]);
    const ref = useCallback(
      (element: HTMLImageElement | null) => {
        if (element?.complete && element.naturalWidth > 0) setLoadedFor(src);
        if (typeof forwarded === 'function') forwarded(element);
        else if (forwarded) forwarded.current = element;
      },
      [forwarded, src]
    );
    const loaded = src !== undefined && loadedFor === src && paintedFor === src;
    return (
      <img
        {...props}
        ref={ref}
        src={src}
        className={['ui-fade-image', className].filter(Boolean).join(' ')}
        data-loaded={loaded || undefined}
        onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
          setLoadedFor(src);
          onLoad?.(event);
        }}
      />
    );
  }
);
