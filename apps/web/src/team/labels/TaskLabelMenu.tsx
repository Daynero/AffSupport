/**
 * The list of a space's tags, as a popover (018).
 *
 * Two surfaces open it — the task editor, to hang tags on a task, and the
 * board, to narrow to a set of them — and both want the same thing: every tag
 * at once, the chosen ones marked, one press each way. So it is one component,
 * multi-select by construction, with a search field only once the dictionary
 * is long enough to need one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { sortTeamTaskLabels, type TeamTaskLabelRef } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskLabelChip } from './TaskLabelChip';
import { SpaceSettingsLink, type SpaceSettingsTarget } from '../SpaceSettingsLink';
import { EmptyState } from '../../components/ui/index';

/** Past this many tags, scanning is slower than typing three letters. */
const SEARCH_FROM = 8;

export function TaskLabelMenu({
  labels,
  selectedIds,
  onToggle,
  ariaLabel,
  emptyText,
  emptyTarget,
  onCreate,
  disabled = false,
  className = ''
}: {
  labels: readonly TeamTaskLabelRef[];
  selectedIds: ReadonlySet<string>;
  onToggle: (label: TeamTaskLabelRef, selected: boolean) => void;
  ariaLabel: string;
  /** What the popover says when the space has no tags at all. */
  emptyText: string;
  /** Where those tags are made, so the empty state is a door and not a notice. */
  emptyTarget?: SpaceSettingsTarget;
  /**
   * Make the tag from here, when the surface can (024, FR-071).
   *
   * Tagging a task with a tag that does not exist yet meant leaving the task,
   * opening the space settings, making it, coming back and finding the task
   * again — for a word. Where this is supplied, the word typed into the search
   * becomes the tag, and the task is tagged with it in the same press.
   */
  onCreate?: (name: string) => Promise<TeamTaskLabelRef | null>;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const sorted = useMemo(() => sortTeamTaskLabels(labels), [labels]);
  const term = search.normalize('NFC').trim().toLocaleLowerCase();
  const shown = term
    ? sorted.filter(label => label.name.toLocaleLowerCase().includes(term))
    : sorted;

  // Opening puts focus in the field or on the first option, so typing and the arrows work at
  // once. After the popover has placed itself: focused during mount, the popover's own focus
  // handling took it back and the first word typed went into the task's title instead (024).
  // The popover is hidden until it has measured where to sit, and a hidden field refuses focus,
  // so this tries each frame until the field has it (a handful of frames at most).
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const place = () => {
      const target =
        root.current?.querySelector<HTMLElement>('input') ??
        root.current?.querySelector<HTMLElement>('[role="option"]');
      target?.focus();
      if (target && document.activeElement !== target && tries < 20) {
        tries += 1;
        frame = requestAnimationFrame(place);
      }
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, []);

  /** ↑/↓ walk the options, Home/End jump: the listbox pattern, not a tab stop each. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (options.length === 0) return;
    const index = options.findIndex(option => option === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(options.length - 1, index + 1)
            : Math.max(0, index - 1);
    event.preventDefault();
    options[next]?.focus();
  };

  return (
    <div
      ref={root}
      className={`team-task-label-menu ${className}`.trim()}
      role="listbox"
      aria-multiselectable="true"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {/* Where tags can be made here, the field is always there — the first tag
          most of all. An empty space used to say "create them in the space's
          settings", a detour out of the task for one word (024). */}
      {(sorted.length >= SEARCH_FROM || onCreate) && (
        <input
          type="search"
          className="team-task-label-menu-search"
          value={search}
          aria-label={t(onCreate ? 'teamTaskTagSearchOrCreate' : 'teamTaskTagSearch')}
          placeholder={t(onCreate ? 'teamTaskTagSearchOrCreate' : 'teamTaskTagSearch')}
          onChange={event => setSearch(event.target.value)}
        />
      )}
      {sorted.length === 0 && !onCreate && (
        <EmptyState
          size="sm"
          className="team-task-label-menu-empty"
          title={emptyText}
          action={emptyTarget && <SpaceSettingsLink target={emptyTarget} />}
        />
      )}

      {sorted.length > 0 && shown.length === 0 && !term && (
        <EmptyState
          size="sm"
          className="team-task-label-menu-empty"
          title={t('teamTaskTagSearchEmpty')}
        />
      )}
      {/* The word you just typed, offered as a tag. Only when it is not one
          already, so the list never shows the same name twice. */}
      {onCreate && term && !sorted.some(label => label.name.toLocaleLowerCase() === term) && (
        <button
          type="button"
          className="team-task-label-option is-create"
          disabled={disabled || creating}
          onClick={() => {
            setCreating(true);
            void onCreate(search.normalize('NFC').trim())
              .then(made => {
                if (made) setSearch('');
              })
              .finally(() => setCreating(false));
          }}
        >
          <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>{t('teamTaskTagCreateNamed', { name: search.trim() })}</span>
        </button>
      )}
      {shown.map(label => {
        const selected = selectedIds.has(label.id);
        return (
          <button
            key={label.id}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={selected}
            className={`team-task-label-option${selected ? ' is-selected' : ''}`}
            disabled={disabled}
            onClick={() => onToggle(label, !selected)}
          >
            <TaskLabelChip label={label} />
            {selected && <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
