import { useEffect, useRef, useState } from 'react';
import type { LaunchSummary } from '@video-compressor/shared';
import { useLaunchCopy } from './useLaunchCopy.js';
export function launchSelectionRange(
  ids: readonly string[],
  anchor: string | null,
  target: string
): string[] {
  const end = ids.indexOf(target),
    start = anchor ? ids.indexOf(anchor) : -1;
  return start < 0 || end < 0
    ? [target]
    : ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}
export function launchShortcutBlocked(target: EventTarget | null): boolean {
  return Boolean(
    (target instanceof Element &&
      target.closest(
        'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]'
      )) ||
    document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]') ||
    window.getSelection()?.toString()
  );
}
export function useLaunchListSelection({
  teamId,
  items,
  selected,
  setSelected,
  open,
  editable,
  onDelete,
  onChanged,
  onError,
  onCopied
}: {
  teamId: string;
  items: LaunchSummary[];
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  open: boolean;
  editable: boolean;
  onDelete: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onCopied: () => void;
}) {
  const anchor = useRef<string | null>(null);
  const [clipboard, setClipboard] = useState<Array<{ id: string; version: string }>>([]);
  const pending = useRef<{
    rows: Array<{ id: string; version: string }>;
    index: number;
    created: string[];
  } | null>(null);
  const active = useRef(true),
    pasting = useRef(false);
  const [busy, setBusy] = useState(false);
  const authority = useRef(editable);
  authority.current = editable;
  const copy = useLaunchCopy(
    teamId,
    detail => {
      pending.current?.created.push(detail.id);
    },
    false
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const select = (id: string, checked: boolean, shift = false) => {
    const next = new Set(selected);
    for (const key of shift
      ? launchSelectionRange(
          items.map(i => i.id),
          anchor.current,
          id
        )
      : [id]) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    anchor.current = id;
    setSelected(next);
  };
  const copySelected = () => {
    const rows = items.filter(i => selected.has(i.id)).map(({ id, version }) => ({ id, version }));
    if (!rows.length) return;
    if (!pasting.current && !copy.hasUnresolvedRequest) pending.current = null;
    setClipboard(rows);
    onCopied();
  };
  const paste = async () => {
    if (pasting.current || !editable || (!pending.current && !clipboard.length)) return;
    pending.current ??= { rows: clipboard, index: 0, created: [] };
    const work = pending.current;
    pasting.current = true;
    setBusy(true);
    try {
      while (work.index < work.rows.length && active.current && authority.current) {
        await copy.copy(work.rows[work.index]);
        if (!active.current) return;
        work.index++;
      }
      if (active.current) {
        setSelected(new Set(work.created));
        onChanged();
      }
      if (work.index === work.rows.length) pending.current = null;
    } catch (error) {
      if (active.current) {
        onError(error);
        onChanged();
      }
    } finally {
      pasting.current = false;
      if (active.current) setBusy(false);
    }
  };
  const handlers = useRef({
    copySelected,
    paste,
    onDelete,
    items,
    selected,
    setSelected,
    open,
    editable
  });
  handlers.current = {
    copySelected,
    paste,
    onDelete,
    items,
    selected,
    setSelected,
    open,
    editable
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const h = handlers.current;
      if (event.defaultPrevented || event.repeat || h.open || launchShortcutBlocked(event.target))
        return;
      const command = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (command && key === 'a') {
        event.preventDefault();
        h.setSelected(new Set(h.items.map(i => i.id)));
      } else if (command && key === 'c' && h.selected.size) {
        event.preventDefault();
        h.copySelected();
      } else if (command && key === 'v' && h.editable) {
        event.preventDefault();
        void h.paste();
      } else if (key === 'escape') {
        h.setSelected(new Set());
      } else if ((key === 'delete' || key === 'backspace') && h.selected.size) {
        event.preventDefault();
        h.onDelete();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  return {
    select,
    copySelected,
    paste,
    canPaste: clipboard.length > 0 || pending.current !== null,
    pasteCount: pending.current
      ? pending.current.rows.length - pending.current.index
      : clipboard.length,
    busy
  };
}
