import type { DragEvent, KeyboardEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { ICON_STROKE } from '../../components/icons';

export interface OrderInteraction {
  label: string;
  targetPosition: 'before' | 'after' | null;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** The same drag and arrow-key grip for both levels of the account list. */
export function OrderHandle({ interaction }: { interaction: OrderInteraction }) {
  return (
    <span
      className="team-order-handle"
      draggable
      onDragStart={interaction.onDragStart}
      onDragEnd={interaction.onDragEnd}
    >
      <IconButton label={interaction.label} title={interaction.label} onKeyDown={interaction.onKeyDown}>
        <GripVertical size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </span>
  );
}
