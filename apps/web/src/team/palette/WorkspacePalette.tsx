import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FileText, FolderOpen, ListPlus, Search, UserRound } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { EmptyState, Spinner } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';

/**
 * One way in, to anything (024, US6).
 *
 * The workspace had four search fields — the folder's, the catalog's, the
 * board's tag filter, the accounts list — and none of them reached past the
 * screen it was on. Finding a task by name meant going to Tasks first; finding
 * a file meant going to Files first; and the thing you were looking for was
 * quite often the reason you wanted to go there at all.
 *
 * This asks once. Results are grouped by what they are, the first is chosen so
 * Enter always does something, and the arrows walk the whole list across group
 * boundaries — a person typing three letters is not thinking in sections.
 *
 * ## Never in the way
 *
 * The field is never disabled and never waits. A search that has not come back
 * leaves the previous answers on screen with a quiet spinner beside the field,
 * because a list that empties itself while you type is a list that makes you
 * stop typing.
 */

export type PaletteKind = 'material' | 'folder' | 'task' | 'account';

export interface PaletteResult {
  id: string;
  kind: PaletteKind;
  name: string;
  /** Where it lives, or what it is about — one line, never two. */
  hint?: string;
  run: () => void;
}

const KIND_ICON: Record<PaletteKind, typeof FileText> = {
  material: FileText,
  folder: FolderOpen,
  task: ListPlus,
  account: UserRound
};

const KIND_HEADING: Record<PaletteKind, TranslationKey> = {
  material: 'paletteGroupMaterials',
  folder: 'paletteGroupFolders',
  task: 'paletteGroupTasks',
  account: 'paletteGroupAccounts'
};

const ORDER: readonly PaletteKind[] = ['material', 'folder', 'task', 'account'];

export function WorkspacePalette({
  query,
  onQueryChange,
  results,
  loading,
  onClose,
  footer
}: {
  query: string;
  onQueryChange: (value: string) => void;
  results: readonly PaletteResult[];
  loading: boolean;
  onClose: () => void;
  /** A line under the list — the shortcut sheet's way in, usually. */
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      ORDER.map(kind => ({ kind, items: results.filter(result => result.kind === kind) })).filter(
        group => group.items.length > 0
      ),
    [results]
  );
  /* The list as one sequence, because that is how the arrows move through it. */
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups]);

  // A new answer starts at the top: the row that was chosen is about a query
  // that is no longer the one in the field.
  useEffect(() => setActive(0), [results]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // Guarded: jsdom has no scrolling, and a palette that throws while you
    // hold Down is worse than one that does not scroll.
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [active]);

  /**
   * Closing first, then going.
   *
   * Both are writes to the address — the palette lives in it, and every result
   * is a link — so the order is the whole of whether it works. Running first
   * put the destination in the history and then the close put the address the
   * palette was opened from straight back on top of it, so Enter appeared to
   * do nothing at all.
   */
  const choose = (item: PaletteResult | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (flat.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(current => (current + step + flat.length) % flat.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : flat.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(flat[active]);
    }
  };

  return (
    <Modal
      labelledBy="workspace-palette-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      size="md"
      initialFocus="#workspace-palette-input"
    >
      <div className="workspace-palette" onKeyDown={onKeyDown}>
        <h2 id="workspace-palette-title" className="visually-hidden">
          {t('paletteTitle')}
        </h2>
        <div className="workspace-palette-field">
          <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            id="workspace-palette-input"
            type="search"
            value={query}
            role="combobox"
            aria-expanded
            aria-controls="workspace-palette-list"
            aria-activedescendant={flat[active] ? `palette-${flat[active]!.id}` : undefined}
            aria-label={t('paletteTitle')}
            placeholder={t('palettePlaceholder')}
            onChange={event => onQueryChange(event.target.value)}
          />
          {/* Beside the field, not in place of the list: the answers that are
              already there stay readable while the next ones are on the way. */}
          {loading && <Spinner size="sm" label={t('loading')} />}
        </div>
        <div
          id="workspace-palette-list"
          className="workspace-palette-list"
          role="listbox"
          ref={listRef}
        >
          {groups.length === 0 && !loading && (
            <EmptyState
              size="sm"
              title={query.trim() === '' ? t('paletteStart') : t('paletteNothing')}
            />
          )}
          {groups.map(group => (
            <div key={group.kind} className="workspace-palette-group" role="group">
              <p className="workspace-palette-heading">{t(KIND_HEADING[group.kind])}</p>
              {group.items.map(item => {
                const index = flat.indexOf(item);
                const Icon = KIND_ICON[item.kind];
                return (
                  <button
                    key={item.id}
                    id={`palette-${item.id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    data-active={index === active}
                    className="workspace-palette-option"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(item)}
                  >
                    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    <span className="workspace-palette-name">{item.name}</span>
                    {item.hint && <small>{item.hint}</small>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {footer}
      </div>
    </Modal>
  );
}
