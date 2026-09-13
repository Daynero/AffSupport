import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredLayer } from '../useAnchoredLayer';
import { uiClasses, type UiSize } from './types';

/**
 * Overlays (021, T022).
 *
 * Modal, Drawer, Popover and DropdownMenu, with one set of rules between them:
 * focus is trapped while open and returned to the trigger on close, Escape
 * closes the innermost one, and the surface grows from its trigger at 0.95
 * scale rather than from nothing (`docs/DESIGN-PRINCIPLES.md` — animating from
 * `scale(0)` looks like a glitch, and a menu that opens away from its button
 * reads as unrelated to it).
 *
 * The menus a person opens dozens of times an hour do not animate at all; that
 * is a rule about frequency, not about taste, and it lives in the stylesheet.
 */

/**
 * One stack for every dialog-like surface in the product.
 *
 * There used to be two — this file's and `components/Modal.tsx`'s — which meant
 * Escape could reach a dialog that was not the top one, and two overlapping
 * dialogs closing out of order could leave `overflow: hidden` on the body with
 * nothing on screen to explain why the page had stopped scrolling. Innermost
 * last; only the last entry reacts to a key.
 */
interface OverlayEntry {
  close: () => void;
  /** Absent for a popover: it closes on Escape but does not trap Tab. */
  surface?: HTMLElement | null;
}

const openStack: OverlayEntry[] = [];

/**
 * What Tab can reach inside a dialog.
 *
 * Anything missing from this list is a control a keyboard user cannot reach
 * while the dialog is up, with no way to tell why — and three kinds were
 * missing from the first version, all three of which this product shows: the
 * transcript editor is a `contenteditable` region, the preview dialogs mount
 * `<video>`/`<audio>` with native controls, and `<summary>` is what opens the
 * details blocks inside the support dialog.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  // `="false"` is the explicit opt-out: matching the attribute alone would trap
  // focus in something the author deliberately made read-only.
  '[contenteditable]:not([contenteditable="false"])',
  'audio[controls]',
  'video[controls]',
  'details > summary',
  'iframe',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

export function focusableIn(surface: HTMLElement): HTMLElement[] {
  const candidates = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    element => !element.closest('[hidden], [aria-hidden="true"], [inert]')
  );
  // Prefer elements that take part in layout — a collapsed panel keeps its
  // controls mounted. jsdom reports no layout at all, so fall back to the
  // attribute list when nothing claims to be visible.
  const visible = candidates.filter(element => element.offsetParent !== null);
  return visible.length ? visible : candidates;
}

/**
 * The page's own scroll setting, held while any dialog is up.
 *
 * It belongs to the stack, not to each dialog: taken when the stack goes
 * empty→one and given back when it goes one→empty, the closing order cannot
 * matter.
 */
let lockedOverflow: string | null = null;

function lockPageScroll(): void {
  if (openStack.length !== 1 || typeof document === 'undefined') return;
  lockedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function unlockPageScroll(): void {
  if (openStack.length > 0 || lockedOverflow === null || typeof document === 'undefined') return;
  document.body.style.overflow = lockedOverflow;
  lockedOverflow = null;
}

export interface DialogBehaviour {
  /** The dialog surface; Tab is kept inside it. */
  surface: RefObject<HTMLElement | null>;
  active?: boolean;
  onClose?: () => void;
  closeOnEscape?: boolean;
  /** CSS selector for what to focus on open; default is the first focusable. */
  initialFocus?: string;
  /** Where focus goes on close; default is whatever had it when the dialog opened. */
  returnFocus?: HTMLElement | null;
  /** Popovers close on Escape but leave Tab alone and do not lock the page. */
  modal?: boolean;
}

/**
 * Everything a dialog does besides drawing itself: join the stack, take focus,
 * keep Tab inside, close on Escape, lock the page, and hand focus back.
 *
 * Both dialog implementations call this — the system's `Modal` below and the
 * product's older `components/Modal.tsx`, which keeps its own API and markup
 * but no longer its own copy of the behaviour.
 */
export function useDialogBehaviour({
  surface,
  active = true,
  onClose,
  closeOnEscape = true,
  initialFocus,
  returnFocus,
  modal = true
}: DialogBehaviour): void {
  // Read from the mount-only effect, so a changing callback does not re-run the
  // trap and steal focus back to the first control mid-edit.
  const live = useRef({ onClose, closeOnEscape, initialFocus, returnFocus });
  live.current = { onClose, closeOnEscape, initialFocus, returnFocus };

  useEffect(() => {
    if (!active) return;
    const node = surface.current;
    const entry: OverlayEntry = {
      close: () => live.current.onClose?.(),
      surface: modal ? node : undefined
    };
    openStack.push(entry);
    const previouslyFocused =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (modal) lockPageScroll();

    let focusFrame = 0;
    if (modal && node) {
      focusFrame = requestAnimationFrame(() => {
        const selector = live.current.initialFocus;
        const target =
          (selector ? node.querySelector<HTMLElement>(selector) : null) ?? focusableIn(node)[0];
        target?.focus();
      });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (openStack.at(-1) !== entry) return;
      if (event.key === 'Escape') {
        if (!live.current.closeOnEscape || !live.current.onClose) return;
        event.preventDefault();
        event.stopPropagation();
        live.current.onClose();
        return;
      }
      if (event.key !== 'Tab' || !modal || !node) return;
      const focusable = focusableIn(node);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const activeElement = document.activeElement;
      const inside = activeElement instanceof HTMLElement && node.contains(activeElement);
      if (event.shiftKey && (!inside || activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      if (focusFrame) cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown, true);
      const at = openStack.lastIndexOf(entry);
      if (at !== -1) openStack.splice(at, 1);
      if (modal) unlockPageScroll();
      (live.current.returnFocus ?? previouslyFocused)?.focus?.();
    };
    // Mount-only on purpose: see `live` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, modal]);
}

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  /** Names the dialog; either this or `labelledBy` is required. */
  title?: ReactNode;
  labelledBy?: string;
  size?: UiSize | 'full';
  /** A dialog raised over another one. */
  nested?: boolean;
  /** Work is running inside: the surface says so and keeps its controls. */
  busy?: boolean;
  className?: string;
  children: ReactNode;
  /** Drawn along the bottom, actions right-aligned. */
  footer?: ReactNode;
}

export function Modal({
  open = true,
  onClose,
  title,
  labelledBy,
  size = 'md',
  nested = false,
  busy = false,
  className,
  children,
  footer
}: ModalProps) {
  const surface = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const close = useCallback(() => onClose(), [onClose]);
  useDialogBehaviour({ surface, active: open, onClose: close });

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={uiClasses('overlay', { states: { nested } })}
      onMouseDown={event => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? generatedId : undefined)}
        aria-busy={busy || undefined}
        className={uiClasses('modal', {
          size: size === 'full' ? undefined : size,
          states: { full: size === 'full', busy },
          className
        })}
      >
        {title && (
          <div className="ui-modal-header">
            <h2 id={generatedId}>{title}</h2>
          </div>
        )}
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export interface DrawerProps extends Omit<ModalProps, 'size'> {
  side?: 'left' | 'right';
  size?: Extract<UiSize, 'sm' | 'md' | 'lg'>;
}

/** A panel that slides in from an edge — the folder tree on a narrow window. */
export function Drawer({ side = 'left', size = 'md', className, ...props }: DrawerProps) {
  return (
    <Modal
      {...props}
      size={size}
      className={['ui-modal--drawer', `ui-modal--drawer-${side}`, className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The element the surface grows out of; its box sets the placement and origin. */
  anchor?: RefObject<HTMLElement | null>;
  /**
   * Which corner it prefers. The side is a preference, not a promise: the
   * placement flips when the window has more room the other way, which is why
   * the surface is portalled out of a card that would otherwise clip it.
   */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** True for something opened many times an hour: no animation at all. */
  frequent?: boolean;
  /** The surface takes the anchor's width — a select, a combobox. */
  matchWidth?: boolean;
  /** Floor for that width, so a short chip does not open an unreadable list. */
  minWidth?: number;
  maxHeight?: number;
  label?: string;
  className?: string;
  children: ReactNode;
}

export function Popover({
  open,
  onClose,
  anchor,
  placement = 'bottom-start',
  frequent = false,
  matchWidth = false,
  minWidth,
  maxHeight,
  label,
  className,
  children
}: PopoverProps) {
  const surface = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useDialogBehaviour({ surface, active: open, onClose: close, modal: false });
  const placed = useAnchoredLayer(anchor ?? emptyAnchor, surface, open && Boolean(anchor), {
    align: placement.endsWith('end') ? 'end' : 'start',
    matchWidth,
    minWidth,
    maxHeight
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (surface.current?.contains(target)) return;
      if (anchor?.current?.contains(target)) return;
      /*
       * A dialog this popover opened is portalled to the body, outside the
       * popover's own subtree — but a press inside it is not "outside the
       * menu". Closing here would unmount the menu and the dialog with it,
       * before the dialog's own click handler ran: the row menu's folder
       * picker used to cancel the move it had just been asked for.
       */
      if (
        target instanceof Element &&
        target.closest('[role="dialog"], .modal-backdrop, .ui-overlay')
      ) {
        return;
      }
      close();
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [anchor, close, open]);

  if (!open || typeof document === 'undefined') return null;

  const surfaceElement = (
    <div
      ref={surface}
      role="dialog"
      aria-label={label}
      className={uiClasses('popover', {
        states: { frequent },
        className: [`ui-popover--${placement}`, className].filter(Boolean).join(' ')
      })}
      style={anchor ? (placed ?? { visibility: 'hidden' }) : undefined}
    >
      {children}
    </div>
  );

  // Anchored surfaces are portalled: a menu inside a list card is clipped by
  // the card, which hides its overflow for the status rail and skips painting
  // what is off screen. Unanchored ones stay where they were written.
  return anchor ? createPortal(surfaceElement, document.body) : surfaceElement;
}

/** A stable empty ref, so the placement hook's arguments keep their shape. */
const emptyAnchor: RefObject<HTMLElement | null> = { current: null };

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A destructive item is quieter than its neighbours, never louder. */
  destructive?: boolean;
  disabled?: boolean;
  /** Drawn right-aligned: a shortcut, a count. */
  trailing?: ReactNode;
  /**
   * Present when the item is one answer to a question the menu is asking —
   * a sort key, a direction, a filter. It then reads as a radio rather than a
   * command, and carries a tick.
   */
  checked?: boolean;
  onSelect: () => void;
}

/** A line naming the question the items under it answer. */
export interface MenuHeading {
  heading: ReactNode;
}

export type MenuEntry = MenuItem | MenuHeading | 'separator';

function isHeading(entry: MenuEntry): entry is MenuHeading {
  return entry !== 'separator' && 'heading' in entry;
}

export interface DropdownMenuProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<MenuEntry>;
  anchor?: RefObject<HTMLElement | null>;
  placement?: PopoverProps['placement'];
  matchWidth?: boolean;
  minWidth?: number;
  maxHeight?: number;
  /**
   * Whether choosing closes the menu. True for a list of commands; false for a
   * menu that asks more than one question — a sort key and a direction and a
   * grouping are three answers, and closing after the first makes the reader
   * open it three times.
   */
  closeOnSelect?: boolean;
  /**
   * What a ticked item means: one answer out of several (`single`) or one of a
   * set that can all be on at once (`multiple`). Only affects items that carry
   * a `checked`.
   */
  selection?: 'single' | 'multiple';
  label: string;
  className?: string;
}

/**
 * The product's twelve menus — sort, kind filter, row actions, export, copy,
 * gallery, user — as one. All of them are opened often, so none of them
 * animate.
 */
export function DropdownMenu({
  open,
  onClose,
  items,
  anchor,
  placement = 'bottom-end',
  matchWidth,
  minWidth,
  maxHeight,
  closeOnSelect = true,
  selection = 'single',
  label,
  className
}: DropdownMenuProps) {
  const [active, setActive] = useState(0);
  const rows = items.filter(
    (item): item is MenuItem => item !== 'separator' && !isHeading(item)
  );

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
      matchWidth={matchWidth}
      minWidth={minWidth}
      maxHeight={maxHeight}
      frequent
      label={label}
      className={['ui-menu', className].filter(Boolean).join(' ')}
    >
      <div
        role="menu"
        aria-label={label}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(current => {
              const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
              return (next + rows.length) % rows.length;
            });
          }
        }}
      >
        {items.map((item, index) =>
          item === 'separator' ? (
            <span key={`separator-${index}`} className="ui-menu-separator" role="separator" />
          ) : isHeading(item) ? (
            <p key={`heading-${index}`} className="ui-menu-heading" role="presentation">
              {item.heading}
            </p>
          ) : (
            <button
              key={item.id}
              type="button"
              role={
                item.checked === undefined
                  ? 'menuitem'
                  : selection === 'multiple'
                    ? 'menuitemcheckbox'
                    : 'menuitemradio'
              }
              aria-checked={item.checked}
              disabled={item.disabled}
              tabIndex={rows.indexOf(item) === active ? 0 : -1}
              className={[
                'ui-menu-item',
                item.destructive ? 'is-destructive' : '',
                item.checked ? 'is-checked' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                item.onSelect();
                if (closeOnSelect) onClose();
              }}
            >
              {item.checked !== undefined && (
                <span className="ui-menu-check" aria-hidden="true">
                  {item.checked ? '✓' : ''}
                </span>
              )}
              {item.icon && (
                <span className="ui-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span className="ui-menu-label">{item.label}</span>
              {item.trailing && <span className="ui-menu-trailing">{item.trailing}</span>}
            </button>
          )
        )}
      </div>
    </Popover>
  );
}
