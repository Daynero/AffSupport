import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Menu as HeroMenu } from '@heroui/react/menu';
import { MenuItem as HeroMenuItem } from '@heroui/react/menu-item';
import { Popover as HeroPopover } from '@heroui/react/popover';
import { MenuSection as HeroMenuSection } from '@heroui/react/menu-section';
import { Header } from 'react-aria-components/Header';
import { Text } from 'react-aria-components/Text';
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

    /*
     * Focus now, not on the next frame.
     *
     * Waiting for a frame was defensive — the portal is already in the document
     * by the time this runs — and it cost two things: a frame in which the
     * dialog is open and nothing is focused, and any way for a test to observe
     * where focus went, since the frame never comes in jsdom. `preventScroll`
     * is what the wait was really protecting against.
     */
    if (modal && node) {
      const selector = live.current.initialFocus;
      const target =
        (selector ? node.querySelector<HTMLElement>(selector) : null) ?? focusableIn(node)[0];
      target?.focus({ preventScroll: true });
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
      /*
       * The toasts are part of the loop (024, T113). A dialog that deletes
       * something offers Undo in a toast, and a trap that cycled only through
       * the dialog made that Undo a mouse-only control while the dialog was
       * up — which is exactly when it is raised.
       */
      const toasts = document.querySelector<HTMLElement>('.ui-toast-region');
      const toastControls = toasts ? focusableIn(toasts) : [];
      const focusable = [...focusableIn(node), ...toastControls];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const activeElement = document.activeElement;
      const inside =
        activeElement instanceof HTMLElement &&
        (node.contains(activeElement) || Boolean(toasts?.contains(activeElement)));
      // The region is portalled apart from the dialog, so the document's own
      // tab order does not lead from one to the other; the step is taken here.
      const at = inside && toastControls.length > 0 ? focusable.indexOf(activeElement) : -1;
      if (at !== -1) {
        event.preventDefault();
        const step = event.shiftKey ? -1 : 1;
        focusable[(at + step + focusable.length) % focusable.length]!.focus();
        return;
      }
      if (event.shiftKey && (!inside || activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    /*
     * On the window, in the bubble phase. The stack already decides which
     * overlay answers Escape; what capture would take away is the chance for
     * something inside the surface to answer first — an inline field in a
     * dialog closes itself and stops the key, and the dialog around it stays
     * open. Capturing here swallowed that field's Escape and left it on screen.
     */
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const at = openStack.lastIndexOf(entry);
      if (at !== -1) openStack.splice(at, 1);
      if (modal) unlockPageScroll();
      /*
       * Give focus back only if nothing else has taken it.
       *
       * A menu that opens a dialog closes on the way, and its cleanup used to
       * pull focus out of the dialog it had just opened and back onto its own
       * trigger — so a rename field opened from a row menu came up with the
       * "…" button focused and the typing went nowhere. If focus has already
       * moved somewhere that is not this surface, it moved there on purpose.
       */
      const active = document.activeElement as HTMLElement | null;
      const stillHere = !active || active === document.body || node?.contains(active);
      if (stillHere) (live.current.returnFocus ?? previouslyFocused)?.focus?.();
    };
    // Mount-only on purpose: `live` above carries the changing callbacks, so
    // the effect does not need them in its list and must not re-run on them.
  }, [active, modal, surface]);
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
  /**
   * A selector for what should hold focus when this opens.
   *
   * Without it the surface focuses the first thing it finds, which is the close
   * button — right for a dialog that is only read, wrong for one that exists to
   * be typed into.
   */
  initialFocus?: string;
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
  footer,
  initialFocus
}: ModalProps) {
  const surface = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const close = useCallback(() => onClose(), [onClose]);
  useDialogBehaviour({ surface, active: open, onClose: close, initialFocus });

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
  /**
   * Other elements that count as "inside". A surface can have a second trigger
   * — the language panel opens from a `?` and from the percentage beside it —
   * and a press on one of those is not a press outside.
   */
  within?: ReadonlyArray<RefObject<HTMLElement | null>>;
  /** The surface takes the anchor's width — a select, a combobox. */
  matchWidth?: boolean;
  /** Floor for that width, so a short chip does not open an unreadable list. */
  minWidth?: number;
  maxHeight?: number;
  label?: string;
  /**
   * What the surface itself is. `dialog` for a panel of controls a person
   * works in; `none` when the content inside already carries the semantics —
   * a menu, a listbox, a group — because two nested roles make the outer one
   * a second dialog nobody meant to open.
   */
  surface?: 'dialog' | 'none';
  className?: string;
  children: ReactNode;
}

export function Popover({
  open,
  onClose,
  anchor,
  placement = 'bottom-start',
  frequent = false,
  within,
  matchWidth = false,
  minWidth,
  maxHeight,
  label,
  surface: surfaceRole = 'dialog',
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
      if (within?.some(element => element.current?.contains(target))) return;
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
  }, [anchor, close, open, within]);

  if (!open || typeof document === 'undefined') return null;

  const surfaceElement = (
    <div
      ref={surface}
      role={surfaceRole === 'none' ? undefined : 'dialog'}
      aria-label={surfaceRole === 'none' ? undefined : label}
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
   * One line under the label, saying why this cannot run right now.
   *
   * A menu item that is present and cannot be chosen owes the reader a reason.
   * Without one it is indistinguishable from a bug, which is what a screen full
   * of dimmed controls always is to the person looking at it.
   */
  note?: ReactNode;
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
 * gallery, user — as one, on React Aria (024).
 *
 * The props are unchanged, because the callers' model is right: the surface
 * that owns the state opens the menu and is told when it closes. React Aria's
 * popover takes exactly that — a trigger ref and a controlled open — so nothing
 * had to be inverted to gain real menu semantics.
 *
 * What is gained: typeahead, Home and End, focus that actually enters the menu
 * and comes back, and `disabledBehavior="selection"` — which is the thing this
 * product hand-rolled last week, a disabled item that stays reachable so the
 * reason it carries can be read.
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
  const rows = items.filter((item): item is MenuItem => item !== 'separator' && !isHeading(item));
  const byId = new Map(rows.map(item => [item.id, item]));

  /*
   * The flat list, folded into sections.
   *
   * A React Aria collection is built from collection components — items,
   * sections, headers — and nothing else: a bare paragraph among them is not
   * rendered late, it stops the whole collection being built. The callers' flat
   * array with heading markers is the right shape to write, so it is folded
   * here rather than pushed back onto twelve call sites.
   */
  /** Whether this menu is asking a question at all, or only listing commands. */
  const menuSelects = rows.some(item => item.checked !== undefined);
  const sections: Array<{ heading: ReactNode | null; items: MenuItem[] }> = [];
  for (const entry of items) {
    // A separator starts a section too, not only a heading: it is how a menu
    // says "and now something else" without naming it, and a group that keeps
    // collecting past one would put a command in with the answers above it.
    if (entry === 'separator') {
      if (sections.at(-1)?.items.length) sections.push({ heading: null, items: [] });
      continue;
    }
    if (isHeading(entry)) {
      sections.push({ heading: entry.heading, items: [] });
      continue;
    }
    if (sections.length === 0) sections.push({ heading: null, items: [] });
    sections[sections.length - 1]!.items.push(entry);
  }

  if (!anchor) return null;

  return (
    <HeroPopover.Content
      triggerRef={anchor as RefObject<HTMLElement>}
      isOpen={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
      /* React Aria spells a placement as a side and an alignment, with a
         space; this product spells it with a hyphen because that is also a
         class name. */
      placement={placement.replace('-', ' ') as 'bottom end'}
      shouldFlip
      className={['ui-popover', 'is-frequent', `ui-popover--${placement}`, 'ui-menu', className]
        .filter(Boolean)
        .join(' ')}
      style={{
        minWidth: matchWidth ? undefined : minWidth,
        maxHeight,
        ['--trigger-width' as string]: matchWidth ? 'var(--trigger-width)' : undefined
      }}
    >
      <HeroMenu
        aria-label={label}
        /*
         * Selection belongs to a section, not to the menu (024).
         *
         * A menu can ask more than one question and still carry a command: a
         * task's menu offers a status, an assignee, a tag — three answers —
         * and a delete. Putting the mode on the menu made every item a radio,
         * so "Delete" announced itself as one of several states the task could
         * be in. A section whose items carry a tick is a radio group; a section
         * of commands is a list of commands.
         */
        selectionMode={menuSelects ? selection : 'none'}
        selectedKeys={rows.filter(item => item.checked).map(item => item.id)}
        disabledKeys={rows.filter(item => item.disabled).map(item => item.id)}
        onAction={key => {
          const item = byId.get(String(key));
          if (!item || item.disabled) return;
          item.onSelect();
          if (closeOnSelect) onClose();
        }}
      >
        {sections.map((section, index) => (
          <HeroMenuSection
            key={`section-${index}`}
            className="ui-menu-section"
            /*
             * Only where the menu is asking something.
             *
             * A section whose items carry a tick is a radio group; a section of
             * commands under the same menu says so, or "Delete" announces
             * itself as one of the states the thing could be in. And where the
             * menu asks nothing at all, the prop is left off entirely —
             * setting it switches the collection's disabled behaviour, and an
             * item that carries a reason has to keep saying it.
             */
            {...(menuSelects
              ? section.items.some(item => item.checked !== undefined)
                ? {
                    selectionMode: selection,
                    selectedKeys: section.items.filter(item => item.checked).map(item => item.id)
                  }
                : { selectionMode: 'none' as const }
              : {})}
          >
            {section.heading !== null && (
              <Header className="ui-menu-heading">{section.heading}</Header>
            )}
            {section.items.map(item => (
              <HeroMenuItem
                key={item.id}
                id={item.id}
                textValue={typeof item.label === 'string' ? item.label : item.id}
                className={[
                  'ui-menu-item',
                  item.destructive ? 'is-destructive' : '',
                  item.checked ? 'is-checked' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
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
                <span className="ui-menu-copy">
                  <Text slot="label" className="ui-menu-label">
                    {item.label}
                  </Text>
                  {item.note && (
                    <Text slot="description" className="ui-menu-note">
                      {item.note}
                    </Text>
                  )}
                </span>
                {item.trailing && <span className="ui-menu-trailing">{item.trailing}</span>}
              </HeroMenuItem>
            ))}
          </HeroMenuSection>
        ))}
      </HeroMenu>
    </HeroPopover.Content>
  );
}
