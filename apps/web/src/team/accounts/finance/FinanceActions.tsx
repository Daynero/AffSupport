import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { DropdownMenu, IconButton } from '../../../components/ui/index';
import type { MenuEntry } from '../../../components/ui/Overlay';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
export function FinanceActions({
  label,
  items,
  disabled = false
}: {
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        title=""
        ref={anchor}
        label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={label}
        items={items}
      />
    </>
  );
}
