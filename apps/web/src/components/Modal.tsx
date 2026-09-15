import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FOCUSABLE_SELECTOR, useDialogBehaviour } from './ui/Overlay';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * The product's original dialog, kept for its API and its markup (021, T023).
 *
 * Everything it used to do by itself — the open stack, the focus trap, the
 * body scroll lock, Escape, focus return — now comes from `ui/Overlay`, so the
 * two dialog implementations share one stack instead of racing each other over
 * the same key events and the same `body.style.overflow`.
 */
export { FOCUSABLE_SELECTOR };

export interface ModalProps {
  /** id of the element that labels the dialog (wired to aria-labelledby). */
  labelledBy: string;
  /**
   * Dismiss callback. When omitted the modal is blocking: no Escape, no
   * backdrop click, no close button (e.g. onboarding, install gate).
   */
  onClose?: () => void;
  /**
   * Rung of the dialog width ladder (`--dialog-sm` … `--dialog-xl` in
   * styles.css). Each rung is a pixel floor that holds on a laptop plus a `vw`
   * share that takes over on a large display, so a dialog keeps its proportion
   * of a 4K screen. Callers pick a rung; they never set a width of their own.
   * Ignored when `bare`.
   */
  size?: ModalSize;
  /** Extra class(es) for the dialog surface. */
  className?: string;
  /**
   * `data-*` attributes for the surface. Full-bleed viewers style themselves
   * from these (device, colour scheme, zoom), and they have to land on the
   * element the stylesheet already targets rather than on a wrapper.
   */
  data?: Record<string, string | undefined>;
  /**
   * Escape hatch for fully custom modals (transcript viewer, image compare):
   * skips the `.modal`/`.modal-backdrop` base classes so the caller's own
   * classes define all styling. Behavior (portal, focus trap, scroll lock,
   * Escape, aria) still applies.
   */
  bare?: boolean;
  /** Extra class(es) for the backdrop element. */
  backdropClassName?: string;
  /** Raises the backdrop above an already-open modal. */
  nested?: boolean;
  /** Hides the backdrop from assistive tech while a nested dialog is open. */
  backdropAriaHidden?: boolean;
  /** Close when the backdrop itself is pressed. Default true. */
  closeOnBackdrop?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Accessible label for the built-in ✕ button; omit to render none. */
  closeLabel?: string;
  /** CSS selector for the element to focus on open (default: first focusable). */
  initialFocus?: string;
  /** Element to restore focus to on close (default: element focused on open). */
  returnFocus?: HTMLElement | null;
  /** Ref to the dialog surface for callers that need DOM access. */
  dialogRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Portaled backdrop-only surface for async routes that must paint the modal
 * background before their dialog content is ready.
 */
export function ModalBackdrop({ className = '' }: { className?: string }) {
  const classes = `modal-backdrop ${className}`.replace(/\s+/g, ' ').trim();
  return createPortal(<div className={classes} aria-hidden="true" />, document.body);
}

/**
 * Shared dialog primitive: portal into <body>, dimmed backdrop, `modal-rise`
 * entrance (disabled under reduced motion via the global CSS), body scroll
 * lock, focus trap and focus restore, Escape/backdrop dismissal and ARIA
 * dialog semantics. There is intentionally no exit animation — the previous
 * modals unmounted instantly and a reliable animated unmount would need
 * presence choreography that is not worth the complexity here.
 */
export function Modal({
  labelledBy,
  onClose,
  size = 'md',
  className = '',
  bare = false,
  data,
  backdropClassName = '',
  nested = false,
  backdropAriaHidden = false,
  closeOnBackdrop = true,
  closeOnEscape = true,
  closeLabel,
  initialFocus,
  returnFocus,
  dialogRef,
  style,
  children
}: ModalProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useDialogBehaviour({
    surface: surfaceRef,
    onClose,
    closeOnEscape,
    initialFocus,
    returnFocus
  });

  const backdropClasses = (
    bare
      ? backdropClassName
      : `modal-backdrop ${nested ? 'modal-backdrop-nested' : ''} ${backdropClassName}`
  )
    .replace(/\s+/g, ' ')
    .trim();
  const surfaceClasses = (bare ? className : `modal modal-${size} ${className}`)
    .replace(/\s+/g, ' ')
    .trim();

  return createPortal(
    <div
      className={backdropClasses}
      aria-hidden={backdropAriaHidden || undefined}
      onPointerDown={event => {
        if (!closeOnBackdrop || !onClose) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={element => {
          surfaceRef.current = element;
          if (dialogRef) dialogRef.current = element;
        }}
        className={surfaceClasses}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={style}
        {...data}
      >
        {onClose && closeLabel && (
          <button type="button" className="modal-close" aria-label={closeLabel} onClick={onClose}>
            ✕
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
