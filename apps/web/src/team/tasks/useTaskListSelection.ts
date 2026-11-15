import { useEffect, useRef, type RefObject } from 'react';
import { launchSelectionRange, launchShortcutBlocked } from '../launches/useLaunchListSelection';

/**
 * Selecting many tasks the way launches are selected: Shift extends from the last
 * ticked card, ⌘/Ctrl+A takes every loaded task, Escape clears, Delete asks to
 * delete the selection. Copy and paste stay with the task clipboard.
 */
export function useTaskListSelection({
  ids,
  selected,
  setSelected,
  enabled,
  anchor,
  onDelete
}: {
  ids: readonly string[];
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  /** False for a viewer and while a task is open. */
  enabled: boolean;
  /** An element on the board: while the board is hidden the keys are not its to answer. */
  anchor?: RefObject<HTMLElement | null>;
  onDelete: () => void;
}) {
  const last = useRef<string | null>(null);
  const select = (id: string, checked: boolean, shift = false) => {
    const next = new Set(selected);
    for (const key of shift ? launchSelectionRange(ids, last.current, id) : [id]) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    last.current = id;
    setSelected(next);
  };
  const latest = useRef({ ids, selected, setSelected, enabled, onDelete });
  latest.current = { ids, selected, setSelected, enabled, onDelete };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const h = latest.current;
      if (
        !h.enabled ||
        event.defaultPrevented ||
        event.repeat ||
        (anchor && (!anchor.current || anchor.current.closest('[hidden]'))) ||
        launchShortcutBlocked(event.target)
      )
        return;
      const command = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (command && key === 'a') {
        if (!h.ids.length) return;
        event.preventDefault();
        h.setSelected(new Set(h.ids));
      } else if (key === 'escape' && h.selected.size) {
        h.setSelected(new Set());
      } else if ((key === 'delete' || key === 'backspace') && !command && h.selected.size) {
        event.preventDefault();
        h.onDelete();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [anchor]);
  return { select };
}
