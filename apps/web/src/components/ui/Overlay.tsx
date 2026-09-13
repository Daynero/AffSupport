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

/** Everything currently open, innermost last — so Escape closes the right one. */
const openStack: Array<() => void> = [];

function useEscape(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    openStack.push(close);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (openStack.at(-1) !== close) return;
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      const at = openStack.lastIndexOf(close);
      if (at !== -1) openStack.splice(at, 1);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active, close]);
}

/** Keeps Tab inside the surface, and puts focus back where it came from. */
function useFocusTrap(active: boolean, container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [
        ...(container.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? [])
      ].filter(element => element.offsetParent !== null || element === document.activeElement);

    const first = focusable()[0];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) return;
      const firstElement = elements[0]!;
      const lastElement = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    const node = container.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [active, container]);
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
  useEscape(open, close);
  useFocusTrap(open, surface);

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
  /** The element the surface grows out of; its box sets the transform origin. */
  anchor?: RefObject<HTMLElement | null>;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** True for something opened many times an hour: no animation at all. */
  frequent?: boolean;
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
  label,
  className,
  children
}: PopoverProps) {
  const surface = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useEscape(open, close);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (surface.current?.contains(target)) return;
      if (anchor?.current?.contains(target)) return;
      close();
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [anchor, close, open]);

  if (!open) return null;
  return (
    <div
      ref={surface}
      role="dialog"
      aria-label={label}
      className={uiClasses('popover', {
        states: { frequent },
        className: [`ui-popover--${placement}`, className].filter(Boolean).join(' ')
      })}
    >
      {children}
    </div>
  );
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A destructive item is quieter than its neighbours, never louder. */
  destructive?: boolean;
  disabled?: boolean;
  /** Drawn right-aligned: a shortcut, a count. */
  trailing?: ReactNode;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<MenuItem | 'separator'>;
  anchor?: RefObject<HTMLElement | null>;
  placement?: PopoverProps['placement'];
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
  label,
  className
}: DropdownMenuProps) {
  const [active, setActive] = useState(0);
  const rows = items.filter((item): item is MenuItem => item !== 'separator');

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
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
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              tabIndex={rows.indexOf(item) === active ? 0 : -1}
              className={`ui-menu-item${item.destructive ? ' is-destructive' : ''}`}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
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
