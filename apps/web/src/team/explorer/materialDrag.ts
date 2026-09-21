import { useCallback, useState, type DragEvent } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { fileCountKey, useI18n } from '../../i18n';
import { DRAG_TYPE } from './rowKinds';

/**
 * Dragging files onto a folder moves them there (011, 024) — the way Drive does it, with the move's
 * Undo on the toast. It was there and nobody could tell: the browser drew the whole row as the
 * ghost, only the one row under the pointer went even when forty were ticked, and only the tree on
 * the left took the drop. Now the ticked files go together, the ghost says what is going, and a
 * folder in the list or the grid takes the drop as well.
 */
export function useMaterialDrag({
  selectedIds,
  rows,
  onDropMaterials
}: {
  selectedIds: ReadonlySet<string>;
  rows: readonly TeamMaterialRow[];
  /** Absent where the reader may not move files: nothing is draggable then. */
  onDropMaterials?: (folderDriveId: string, materialIds: string[]) => void;
}) {
  const { t, language } = useI18n();
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const dragProps = useCallback(
    (row: TeamMaterialRow) => {
      if (!onDropMaterials) return {};
      return {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
          const ids = selectedIds.has(row.id)
            ? rows.filter(item => selectedIds.has(item.id)).map(item => item.id)
            : [row.id];
          event.dataTransfer.setData(DRAG_TYPE, ids.join(','));
          event.dataTransfer.effectAllowed = 'move';
          const label =
            ids.length === 1
              ? row.name
              : t(fileCountKey(language, ids.length), { count: ids.length });
          showGhost(event, label);
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget(row.id);
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTarget(current => (current === row.id ? null : current));
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          const raw = event.dataTransfer.getData(DRAG_TYPE);
          setDropTarget(null);
          if (!raw) return;
          event.preventDefault();
          event.stopPropagation();
          onDropMaterials(row.driveFileId, raw.split(',').filter(Boolean));
        }
      };
    },
    [language, onDropMaterials, rows, selectedIds, t]
  );

  return { dragProps, dropTarget };
}

function showGhost(event: DragEvent<HTMLElement>, label: string) {
  if (typeof document === 'undefined' || !event.dataTransfer.setDragImage) return;
  const ghost = document.createElement('div');
  ghost.className = 'team-explorer-drag-ghost';
  ghost.textContent = label;
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, -12, -12);
  window.setTimeout(() => ghost.remove(), 0);
}
