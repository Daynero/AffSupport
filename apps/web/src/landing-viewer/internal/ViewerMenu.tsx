import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from 'react';
import { Check } from 'lucide-react';
import { Popover } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

/**
 * A toolbar menu: a trigger button and a popover on the body, placed beside it.
 *
 * The surface, its placement and its dismissal are the inventory's Popover
 * (021, T072); what stays here is the trigger and the arrow-key walk, which
 * every menu in the viewer shares — focus lands on the first choice, arrows
 * move, Escape and Tab return to the trigger.
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
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Node;
      const inside = root.current?.contains(target) || menu.current?.contains(target);
      if (!inside) return;
      // Tab leaves the menu the way Escape does — the surface is on the body,
      // so a natural Tab out of it lands on the first link of the page.
      if (event.key === 'Tab') {
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
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
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
      <Popover
        open={open}
        onClose={() => close(true)}
        anchor={root}
        placement={align === 'end' ? 'bottom-end' : 'bottom-start'}
        frequent
        label={label}
        surface="none"
        className="lv-menu"
      >
        <div id={id} ref={menu} role="menu" aria-label={label} className="lv-menu-items">
          {children(() => close(true))}
        </div>
      </Popover>
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
