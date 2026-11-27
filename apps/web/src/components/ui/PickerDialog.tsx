import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import { Check, ChevronRight, LayoutGrid, List } from 'lucide-react';
import { Modal } from '../Modal';
import { ICON_SIZE, ICON_STROKE } from '../icons';
import { Button } from './Button';
import { EmptyState, ErrorState, LoadingState } from './patterns';
import { SearchField } from './Field';
import { SegmentedControl } from './Choice';

/**
 * 075 — one window for choosing things.
 *
 * Every «choose …» in the space used to be its own dialog: the creative and
 * attachment picker, «Add to task…», the account picker, each with its own
 * height, its own empty line and its own keys. This is the shell they share; what
 * is listed (folders, files, tasks, launches) stays with the caller.
 *
 * Keys: the search field keeps focus; ↑↓ (and ←→ in the grid) move the active
 * option, Enter picks it (opens a folder, ticks a file, or — in `commit` mode —
 * chooses it), ⌘/Ctrl+Enter confirms the choice, Escape clears the search and
 * then closes.
 */
export interface PickerItem {
  id: string;
  title: string;
  /** A second line: where it is, its state, why it cannot be chosen. */
  subtitle?: ReactNode;
  /** A type glyph; drawn in the list, and in a tile with no picture. */
  icon?: ReactNode;
  /** The tile's picture (the grid only). */
  thumbnailUrl?: string | null;
  /** A folder or another level: opens instead of being ticked. */
  branch?: boolean;
  disabled?: boolean;
  /** An action row such as «+ New task», drawn apart from the results. */
  action?: boolean;
}

export type PickerView = 'list' | 'grid';
/** `multiple`/`single` tick and confirm; `commit` chooses on the first pick. */
export type PickerMode = 'multiple' | 'single' | 'commit';

export interface PickerDialogProps {
  title: ReactNode;
  onClose: () => void;
  closeLabel: string;
  size?: 'sm' | 'lg' | 'xl';
  /** Over another dialog (a task editor, a launch form). */
  nested?: boolean;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    clearLabel: string;
  };
  /** Filters and the like, beside the view switch. */
  toolbar?: ReactNode;
  /** The breadcrumb of the open level. */
  trail?: ReactNode;
  views?: readonly PickerView[];
  defaultView?: PickerView;
  /** Where the person's list/grid choice is remembered; nothing is remembered without it. */
  viewKey?: string;
  viewLabels?: { list: string; grid: string; label: string };
  items: readonly PickerItem[];
  loading?: boolean;
  loadingLabel: string;
  error?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  empty: { title: string; description?: string };
  selected?: ReadonlySet<string>;
  mode: PickerMode;
  /** A press or Enter on an option. The caller opens, ticks or chooses. */
  onPick: (item: PickerItem) => void;
  footer?: {
    summary?: ReactNode;
    cancelLabel: string;
    confirmLabel: ReactNode;
    confirmDisabled?: boolean;
    busy?: boolean;
    onConfirm: () => void;
  };
  busy?: boolean;
  className?: string;
  /** Where focus lands when there is no search box (a selector inside the window). */
  initialFocus?: string;
}

const VIEW_KEY_PREFIX = 'soty.picker.view.';

function rememberedView(key: string | undefined, views: readonly PickerView[]): PickerView | null {
  if (!key) return null;
  try {
    const value = localStorage.getItem(`${VIEW_KEY_PREFIX}${key}`);
    return value === 'list' || value === 'grid' ? (views.includes(value) ? value : null) : null;
  } catch {
    return null;
  }
}

function remember(key: string | undefined, view: PickerView) {
  if (!key) return;
  try {
    localStorage.setItem(`${VIEW_KEY_PREFIX}${key}`, view);
  } catch {
    /* the choice lasts for this window only */
  }
}

/** How many tiles a grid row holds, read from the laid-out grid. */
function columnsOf(grid: HTMLElement | null): number {
  if (!grid || typeof getComputedStyle !== 'function') return 1;
  const template = getComputedStyle(grid).gridTemplateColumns;
  const count = template ? template.split(' ').filter(Boolean).length : 1;
  return Math.max(1, count);
}

function Thumbnail({ item }: { item: PickerItem }) {
  const [failed, setFailed] = useState(false);
  if (item.thumbnailUrl && !failed)
    return (
      <img
        src={item.thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  return <span className="ui-picker-tile-glyph">{item.icon}</span>;
}

export function PickerDialog({
  title,
  onClose,
  closeLabel,
  size = 'lg',
  nested = true,
  search,
  toolbar,
  trail,
  views = ['list'],
  defaultView,
  viewKey,
  viewLabels,
  items,
  loading = false,
  loadingLabel,
  error = null,
  onRetry,
  retryLabel,
  empty,
  selected,
  mode,
  onPick,
  footer,
  busy = false,
  className,
  initialFocus
}: PickerDialogProps) {
  const titleId = useId();
  const listId = useId();
  const searchId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [view, setView] = useState<PickerView>(
    () => rememberedView(viewKey, views) ?? defaultView ?? views[0] ?? 'list'
  );
  const [active, setActive] = useState(0);
  const actions = useMemo(() => items.filter(item => item.action), [items]);
  const results = useMemo(() => items.filter(item => !item.action), [items]);
  const ordered = useMemo(() => [...actions, ...results], [actions, results]);
  const grid = view === 'grid';

  // A new answer (search, folder) starts at its first option — a new answer, not a new render.
  const answer = ordered.map(item => item.id).join('\n');
  useEffect(() => setActive(0), [answer]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    setActive(index => Math.min(Math.max(index + delta, 0), ordered.length - 1));
  };

  const pick = (item: PickerItem | undefined) => {
    if (!item || item.disabled || busy) return;
    onPick(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = grid ? columnsOf(listRef.current) : 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(grid && active >= actions.length ? step : 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(grid && active - step >= actions.length ? -step : -1);
    } else if (grid && event.key === 'ArrowRight' && !search?.value) {
      event.preventDefault();
      move(1);
    } else if (grid && event.key === 'ArrowLeft' && !search?.value) {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && footer && !footer.confirmDisabled) {
        footer.onConfirm();
        return;
      }
      pick(ordered[active]);
    }
  };

  const option = (item: PickerItem, index: number) => {
    const isSelected = selected?.has(item.id) ?? false;
    const optionId = `${listId}-${index}`;
    return (
      <li
        key={item.id}
        id={optionId}
        role="option"
        data-index={index}
        aria-selected={mode === 'commit' ? index === active : isSelected}
        aria-disabled={item.disabled || undefined}
        className="ui-picker-option"
        data-active={index === active || undefined}
        data-selected={isSelected || undefined}
        data-branch={item.branch || undefined}
        data-action={item.action || undefined}
        onMouseMove={() => {
          if (index !== active) setActive(index);
        }}
        onClick={() => {
          setActive(index);
          pick(item);
        }}
      >
        {grid && !item.action ? (
          <>
            <span className="ui-picker-tile-media">
              <Thumbnail item={item} />
              {!item.branch && (
                <span className="ui-picker-tick" aria-hidden="true">
                  {isSelected && <Check size={14} strokeWidth={ICON_STROKE} />}
                </span>
              )}
            </span>
            <span className="ui-picker-copy">
              <strong>{item.title}</strong>
              {item.subtitle && <small>{item.subtitle}</small>}
            </span>
          </>
        ) : (
          <>
            <span className="ui-picker-glyph" aria-hidden="true">
              {item.icon}
            </span>
            <span className="ui-picker-copy">
              <strong>{item.title}</strong>
              {item.subtitle && <small>{item.subtitle}</small>}
            </span>
            <span className="ui-picker-trail" aria-hidden="true">
              {item.branch ? (
                <ChevronRight size={14} strokeWidth={ICON_STROKE} />
              ) : isSelected ? (
                <Check size={14} strokeWidth={ICON_STROKE} />
              ) : null}
            </span>
          </>
        )}
      </li>
    );
  };

  const showViews = views.length > 1 && viewLabels;
  return (
    <Modal
      layout="search"
      nested={nested}
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={closeLabel}
      initialFocus={search ? `#${CSS.escape(searchId)}` : initialFocus}
      size={size === 'sm' ? 'sm' : size}
      className={`ui-picker ui-picker-${size}${className ? ` ${className}` : ''}`}
    >
      <div
        className="ui-picker-frame"
        onKeyDown={event => {
          // Without a search box the frame answers; with one, the box does (React Aria keeps
          // its keys from bubbling). A toolbar button's Enter is its own.
          if (!search && event.target === event.currentTarget) onKeyDown(event);
        }}
        tabIndex={search ? undefined : -1}
      >
        <div className="ui-picker-heading">
          <h2 id={titleId}>{title}</h2>
        </div>
        {(search || toolbar || showViews) && (
          <div className="ui-picker-bar">
            {search && (
              <SearchField
                id={searchId}
                className="ui-picker-search"
                value={search.value}
                aria-label={search.placeholder}
                placeholder={search.placeholder}
                clearLabel={search.clearLabel}
                onChange={search.onChange}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-controls={listId}
                aria-activedescendant={active < ordered.length ? `${listId}-${active}` : undefined}
              />
            )}
            {toolbar}
            {showViews && (
              <SegmentedControl
                className="ui-picker-views"
                label={viewLabels.label}
                value={view}
                onChange={next => {
                  const value = next as PickerView;
                  setView(value);
                  remember(viewKey, value);
                }}
                size="sm"
                options={views.map(value => {
                  const name = value === 'grid' ? viewLabels.grid : viewLabels.list;
                  return {
                    value,
                    title: name,
                    label: (
                      <>
                        {value === 'grid' ? (
                          <LayoutGrid
                            size={ICON_SIZE}
                            strokeWidth={ICON_STROKE}
                            aria-hidden="true"
                          />
                        ) : (
                          <List size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        )}
                        <span className="visually-hidden">{name}</span>
                      </>
                    )
                  };
                })}
              />
            )}
          </div>
        )}
        {trail && <div className="ui-picker-trail-bar">{trail}</div>}
        <div className="modal-search-results ui-picker-results" aria-busy={loading || undefined}>
          {loading ? (
            <LoadingState shape={grid ? 'tile' : 'row'} count={grid ? 8 : 5} label={loadingLabel} />
          ) : error ? (
            <ErrorState message={error} onRetry={onRetry} retryLabel={retryLabel} />
          ) : ordered.length === 0 ? (
            <EmptyState size="sm" title={empty.title} description={empty.description} />
          ) : (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={titleId}
              aria-multiselectable={mode === 'multiple' || undefined}
              className="ui-picker-list"
              data-view={view}
            >
              {ordered.map((item, index) => option(item, index))}
            </ul>
          )}
        </div>
        {footer && (
          <div className="ui-picker-footer">
            <span className="ui-picker-summary" aria-live="polite">
              {footer.summary}
            </span>
            <Button type="button" variant="ghost" color="neutral" onClick={onClose}>
              {footer.cancelLabel}
            </Button>
            <Button
              type="button"
              color="primary"
              disabled={footer.confirmDisabled}
              loading={footer.busy}
              onClick={footer.onConfirm}
            >
              {footer.confirmLabel}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
