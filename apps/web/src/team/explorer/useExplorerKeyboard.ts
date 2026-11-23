import { useEffect, type KeyboardEvent, type RefObject } from 'react';
import type { TeamMaterialRow, TeamPermissions } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import type { ExplorerView, TeamRouteQuery } from '../routes';
import type { useExplorer } from './ExplorerProvider';
import type { useExplorerClipboard } from './useExplorerClipboard';
import { summaryOf } from './summary';
import { EXPLORER_SEARCH_ATTRIBUTE } from './ExplorerToolbar';

/**
 * The explorer's keys, out of `ExplorerShell` (070, FR-001): the content area's own, and the
 * three the folder screen listens for on the whole document — `/` for the search, ⌘C/⌘X/⌘V
 * for the clipboard, ⌘A and Escape for the selection.
 */
export function useExplorerKeyboard({
  surfaceRef,
  sortedRows,
  selectedId,
  select,
  clearSelection,
  focused,
  view,
  explorer,
  onPreview,
  selectedRows,
  permissions,
  trashRows,
  searching,
  trash,
  readOnly,
  onQueryChange,
  clipboard,
  currentFolderId
}: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  sortedRows: TeamMaterialRow[];
  selectedId: string | null;
  select: (id: string | null) => void;
  clearSelection: () => void;
  focused: TeamMaterialRow | null;
  view: ExplorerView;
  explorer: ReturnType<typeof useExplorer>;
  onPreview?: (material: TeamMaterialSummary) => void;
  selectedRows: TeamMaterialRow[];
  permissions: TeamPermissions | null;
  trashRows: (rows: TeamMaterialRow[]) => Promise<void>;
  searching: boolean;
  trash: boolean;
  readOnly: boolean;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  clipboard: ReturnType<typeof useExplorerClipboard>;
  currentFolderId: string | null;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  /**
   * Keyboard on the content area (FR-027): arrows move, Enter opens, Escape
   * clears, Delete trashes with undo. Keys typed into a field — the rename
   * form inside a row menu, most of all — are that field's; letting them
   * through here opened a preview on Enter and toggled the selection on every
   * space in the new name.
   */
  const onContentKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (sortedRows.length === 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditableTarget(target) || target?.closest('.team-row-menu')) return;
    const index = sortedRows.findIndex(row => row.id === selectedId);
    const step = view === 'grid' ? gridColumns(event.currentTarget) : 1;
    let next: TeamMaterialRow | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = sortedRows[Math.min(sortedRows.length - 1, index < 0 ? 0 : index + step)];
        break;
      case 'ArrowUp':
        next = sortedRows[Math.max(0, index - step)];
        break;
      case 'ArrowRight':
        if (view !== 'grid') return;
        next = sortedRows[Math.min(sortedRows.length - 1, index + 1)];
        break;
      case 'ArrowLeft':
        if (view !== 'grid') return;
        next = sortedRows[Math.max(0, index - 1)];
        break;
      case 'Enter':
        if (!focused) return;
        if (focused.kind === 'folder') explorer.openFolder(focused.driveFileId);
        else onPreview?.(summaryOf(focused));
        break;
      case 'Escape':
        select(null);
        clearSelection();
        break;
      case ' ':
        if (focused) explorer.toggleSelected(focused);
        break;
      case 'Delete':
      case 'Backspace': {
        const rows = selectedRows.length > 0 ? selectedRows : focused ? [focused] : [];
        if (rows.length === 0 || !permissions?.delete) return;
        void trashRows(rows);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next) select(next.id);
  };

  /* The explorer stays mounted while another section is showing, hidden. Its
     document-level shortcuts must not act from there: Cmd+C on a task card copied
     the explorer's focused file, Cmd+V pasted a duplicate into the open folder,
     and the copy event Tasks listens for never fired. */
  const onScreen = () => {
    const surface = surfaceRef.current;
    return Boolean(surface && !surface.closest('[hidden]'));
  };

  // `/` opens the search from anywhere on the folder screen (FR-027). The
  // search bar binds the same key once it is mounted; before that there was
  // nothing listening, so the shortcut only worked when it was not needed.
  useEffect(() => {
    if (searching || trash) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!onScreen()) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      event.preventDefault();
      // The toolbar's box takes the caret (070, T012); without one, the search opens.
      const box = surfaceRef.current?.querySelector<HTMLInputElement>(
        `[${EXPLORER_SEARCH_ATTRIBUTE}] input`
      );
      if (box) box.focus();
      else onQueryChange({ scope: 'space' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onQueryChange, searching, surfaceRef, trash]);

  // Cmd/Ctrl+C copies, +X cuts, +V pastes into the open folder — from anywhere
  // on the folder screen, because focus rarely sits inside the list. The batch
  // is the toggled selection (even from other folders), or the focused row.
  useEffect(() => {
    if (searching || trash || readOnly) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (!onScreen()) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      /* Text first (063): a transcript, its translation or a note selected with the mouse is
         what Cmd+C means, and inside a dialog the folder is not what the keys are about.
         Files are copied only when nothing is selected on the page. */
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"], [role="alertdialog"]')
      )
        return;
      const key = event.key.toLowerCase();
      if ((key === 'c' || key === 'x') && (window.getSelection()?.toString().trim() ?? '') !== '')
        return;
      if (key === 'c' || key === 'x') {
        const rows = selectedRows.length > 0 ? selectedRows : focused ? [focused] : [];
        if (rows.length === 0) return;
        clipboard.take(
          key === 'c' ? 'copy' : 'cut',
          rows.map(row => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            category: row.category,
            sourceFolderId: row.parentFolderId ?? currentFolderId ?? null
          }))
        );
        push({
          tone: 'success',
          text: t(key === 'c' ? 'teamExplorerCopiedCount' : 'teamExplorerCutCount', {
            count: rows.length
          })
        });
        event.preventDefault();
        return;
      }
      if (key === 'v' && clipboard.has()) {
        event.preventDefault();
        void clipboard.paste();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    /* The handler reads the current selection and the open folder, and this
       component re-renders on every toast and every page. With no dependency
       list at all a document-level listener was torn down and rebuilt on each
       of those. */
  }, [clipboard, focused, push, readOnly, searching, selectedRows, t, trash]);

  // Cmd/Ctrl+A checks every loaded row of the open folder, as the bar's Select all does — the
  // page's own select-all would only have painted the text of the screen blue.
  useEffect(() => {
    if (searching || trash) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      /* Escape lets go of a selection from anywhere on the folder screen, as ⌘A makes one
         from anywhere: after ⌘A the focus is on the page, not the list, and the list's own
         Escape never heard it. The list still handles it first when it has the focus. */
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        selectedRows.length > 0 &&
        onScreen() &&
        !isEditableTarget(target) &&
        !target?.closest('[role="dialog"], [role="menu"], .team-explorer-content-keys')
      ) {
        explorer.clearSelection();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'a') return;
      if (!onScreen()) return;
      if (isEditableTarget(target) || target?.closest('[role="dialog"], [role="menu"]')) return;
      if (sortedRows.length === 0) return;
      event.preventDefault();
      explorer.selectRows(sortedRows);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [explorer, searching, selectedRows.length, sortedRows, trash]);

  return onContentKeyDown;
}

/** Someone typing owns their keys; the explorer's shortcuts never apply there. */
function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function gridColumns(element: HTMLElement): number {
  const grid = element.querySelector<HTMLElement>('.team-explorer-grid');
  if (!grid) return 1;
  const tiles = grid.querySelectorAll<HTMLElement>('.team-explorer-tile');
  if (tiles.length < 2) return 1;
  const firstTop = tiles[0]!.offsetTop;
  let columns = 1;
  for (let index = 1; index < tiles.length; index += 1) {
    if (tiles[index]!.offsetTop !== firstTop) break;
    columns += 1;
  }
  return Math.max(1, columns);
}
