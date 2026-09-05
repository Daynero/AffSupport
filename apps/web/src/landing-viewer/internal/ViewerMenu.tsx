import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useAnchoredLayer } from '../../components/useAnchoredLayer';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

/**
 * A toolbar menu: a trigger button and a popover on the body, placed beside it.
 *
 * The same menu as the transcription tool's export menu — focus lands on the first choice,
 * arrows move, Escape and Tab return to the trigger, a click elsewhere closes it — so every
 * dropdown in the viewer behaves the same way and none of them stack: opening one closes
 * whichever was open, because each listens for the pointer that opened the other.
 */
export function ViewerMenu({
  label,
  align = 'end',
  className = '',
  triggerClassName = '',
  trigger,
  disabled = false,
  pressed,
  children
}: {
  /** The trigger's accessible name and, for an icon-only trigger, its delayed hint. */
  label: string;
  align?: 'start' | 'end';
  className?: string;
  triggerClassName?: string;
  trigger: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const style = useAnchoredLayer(root, menu, open, { align, gap: 6 });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const items = () =>
      Array.from(
        menu.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
        ) ?? []
      );
    items()[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Node;
      const inside = root.current?.contains(target) || menu.current?.contains(target);
      if (!inside && event.key !== 'Escape') return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list[(index + 1) % list.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        list.at(-1)?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div className={`lv-menu-root ${className}`.trim()} ref={root}>
      <button
        ref={button}
        type="button"
        className={`lv-btn lv-tip ${triggerClassName}`.trim()}
        data-tooltip={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={menu}
            role="menu"
            aria-label={label}
            className="lv-menu"
            // The placement hook stacks a layer at the popover level, which is below the viewer's
            // own fixed layer; the menu must sit above the toolbar that opened it.
            style={{
              ...(style ?? { position: 'fixed', visibility: 'hidden' }),
              zIndex: 'var(--layer-modal-nested)' as unknown as number
            }}
          >
            {children(() => close(true))}
          </div>,
          document.body
        )}
    </div>
  );
}

export function MenuItem({
  icon,
  title,
  detail,
  checked,
  current,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  title?: string;
  detail?: string;
  /** Renders as a radio entry with a check mark when chosen. */
  checked?: boolean;
  /** The entry that is already active (the open folder), without radio semantics. */
  current?: boolean;
}) {
  const radio = checked !== undefined;
  return (
    <button
      {...props}
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      aria-current={current ? 'true' : undefined}
      className={`lv-menu-item ${className}`.trim()}
    >
      {icon}
      {title !== undefined ? (
        <span className="lv-menu-item-copy">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
      ) : (
        children
      )}
      {radio && checked && (
        <Check
          className="lv-menu-item-check"
          size={ICON_SIZE - 2}
          strokeWidth={ICON_STROKE + 0.5}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="lv-menu-heading">{children}</div>;
}

export function MenuSeparator() {
  return <div className="lv-menu-separator" role="separator" />;
}
