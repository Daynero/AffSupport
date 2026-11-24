import { useCallback, useMemo, useRef, useState } from 'react';
import type { CatalogMaterialItem } from '@video-compressor/shared';
import { isApple } from '../palette/shortcuts';
import {
  applyPress,
  pressKind,
  sameSet,
  type Modifiers,
  type SelectionAnchor
} from './selectionGestures';

/**
 * Selection in the search's results (070, T022), in the folder list's grammar: the focused row
 * the details pane describes and the arrows move from, and the checked set a batch acts on. A
 * plain press focuses, ⌘/Ctrl adds or removes one, Shift takes the run from the anchor — the
 * same pure functions the folder list runs (`selectionGestures.ts`).
 *
 * Its own state rather than the folder's: a result is a catalog item, not a folder row, and
 * the folder's selection carries the rows' provider ids and versions, which a result does not
 * have and must not be given invented ones. The checked set outlives a new query — a batch can
 * be gathered over several searches — and goes with the search when the search is put away.
 */
export function useResultSelection(items: readonly CatalogMaterialItem[]) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlyMap<string, CatalogMaterialItem>>(() => new Map());
  const anchor = useRef<SelectionAnchor | null>(null);
  const latest = useRef({ items, focusedId, checked });
  latest.current = { items, focusedId, checked };

  const replace = useCallback((next: Iterable<CatalogMaterialItem>) => {
    setChecked(new Map([...next].map(item => [item.id, item])));
  }, []);

  const press = useCallback(
    (item: CatalogMaterialItem, modifiers: Modifiers) => {
      const { items: current, focusedId: focus, checked: was } = latest.current;
      const kind = pressKind(modifiers, isApple());
      const result = applyPress({
        kind,
        clickedId: item.id,
        order: current.map(entry => entry.id),
        checked: new Set(was.keys()),
        focusedId: focus,
        anchor: anchor.current
      });
      anchor.current = result.anchor;
      if (kind === 'range') window.getSelection?.()?.removeAllRanges();
      setFocusedId(result.focusId);
      if (!sameSet(result.checked, new Set(was.keys()))) {
        const byId = new Map(current.map(entry => [entry.id, entry]));
        replace(
          [...result.checked]
            .map(id => byId.get(id) ?? was.get(id))
            .filter((entry): entry is CatalogMaterialItem => Boolean(entry))
        );
      }
    },
    [replace]
  );

  const toggle = useCallback((item: CatalogMaterialItem) => {
    setChecked(current => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    setChecked(new Map());
  }, []);

  /** The results on screen now, all checked, with what was checked before kept. */
  const checkAll = useCallback(() => {
    setChecked(current => {
      const next = new Map(current);
      for (const item of latest.current.items) next.set(item.id, item);
      return next;
    });
  }, []);

  /** Forgets what went away (trashed, moved out of reach): it is no longer there to act on. */
  const drop = useCallback((ids: readonly string[]) => {
    setChecked(current => {
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setFocusedId(current => (current && ids.includes(current) ? null : current));
  }, []);

  /** The focused result, as it is now — a fresh answer may carry a newer copy of it. */
  const focused = useMemo(
    () => items.find(item => item.id === focusedId) ?? null,
    [focusedId, items]
  );
  const checkedItems = useMemo(() => [...checked.values()], [checked]);

  return {
    focusedId,
    focused,
    focus: setFocusedId,
    checked,
    checkedItems,
    press,
    toggle,
    clear,
    checkAll,
    drop
  };
}

export type ResultSelection = ReturnType<typeof useResultSelection>;
