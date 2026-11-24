import { useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, type MenuEntry } from '../../components/ui/index';
import { GalleryIconButton } from './GalleryIconButton';

/**
 * A toolbar menu: the viewer's own trigger and the inventory's `DropdownMenu` (070 T037).
 *
 * The trigger is the toolbar's button, so it lines up with and folds like its neighbours;
 * everything past it — the surface on the body, its placement, focus landing on the first
 * choice, the arrow, Home and End walk, typeahead, Escape and Tab returning to the trigger,
 * radio and checkbox semantics — is the menu's.
 */
export function ViewerMenu({
  label,
  align = 'end',
  className = '',
  triggerClassName = '',
  trigger,
  disabled = false,
  pressed,
  items
}: {
  /** The trigger's accessible name and, for an icon-only trigger, its delayed hint. */
  label: string;
  align?: 'start' | 'end';
  className?: string;
  triggerClassName?: string;
  trigger: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  items: ReadonlyArray<MenuEntry>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  return (
    <div className={`lv-menu-root ${className}`.trim()}>
      <GalleryIconButton
        ref={button}
        className={triggerClassName}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {trigger}
      </GalleryIconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        placement={align === 'end' ? 'bottom-end' : 'bottom-start'}
        minWidth={220}
        label={label}
        items={items}
      />
    </div>
  );
}
