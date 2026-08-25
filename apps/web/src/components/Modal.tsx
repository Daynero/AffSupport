import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * What Tab can reach inside a dialog.
 *
 * The list decides where focus goes when a dialog opens and where it wraps at
 * the end — so anything missing from it is a control a keyboard user cannot
 * reach while the dialog is up, with no way to tell why.
 *
 * Three kinds were missing, and all three appear in dialogs this application
 * actually shows: the transcript editor is a `contenteditable` region, the
 * preview dialogs mount `<video>` and `<audio>` with native controls, and
 * `<summary>` is what opens the details blocks inside the support dialog.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  // An editable region is focusable without a tabindex, and `="false"` is the
  // explicit opt-out — matching on the attribute alone would trap focus in
  // something the author deliberately made read-only.
  '[contenteditable]:not([contenteditable="false"])',
  'audio[controls]',
  'video[controls]',
  'details > summary',
  'iframe',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * Stack of currently open modal surfaces. Only the top-most modal reacts to
 * Escape and traps Tab, so nested dialogs (e.g. the Windows notice above the
 * install dialog) never fight over the same key events.
 */
const openModals: HTMLElement[] = [];

function focusableIn(surface: HTMLElement): HTMLElement[] {
  const candidates = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    element => !element.closest('[hidden], [aria-hidden="true"], [inert]')
  );
  // Prefer elements that take part in layout (collapsed panels keep their
  // controls mounted). jsdom reports no layout at all, so fall back to the
  // attribute-based list when nothing is "visible".
  const visible = candidates.filter(element => element.offsetParent !== null);
  return visible.length ? visible : candidates;
}

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
  // Live values readable from the mount-only effect below.
  const current = useRef({ onClose, closeOnEscape, initialFocus, returnFocus });
  current.current = { onClose, closeOnEscape, initialFocus, returnFocus };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    openModals.push(surface);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusFrame = requestAnimationFrame(() => {
      const selector = current.current.initialFocus;
      const target =
        (selector ? surface.querySelector<HTMLElement>(selector) : null) ?? focusableIn(surface)[0];
      target?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== surface) return;
      if (event.key === 'Escape') {
        if (!current.current.closeOnEscape || !current.current.onClose) return;
        event.preventDefault();
        current.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableIn(surface);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && surface.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      const index = openModals.indexOf(surface);
      if (index !== -1) openModals.splice(index, 1);
      document.body.style.overflow = previousOverflow;
      (current.current.returnFocus ?? previouslyFocused)?.focus();
    };
  }, []);

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
