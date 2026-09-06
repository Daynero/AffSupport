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
import { Check } from 'lucide-react';
import { sortTeamTaskLabels, type TeamTaskLabelRef } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskLabelChip } from './TaskLabelChip';

/** Past this many tags, scanning is slower than typing three letters. */
const SEARCH_FROM = 8;

export function TaskLabelMenu({
  labels,
  selectedIds,
  onToggle,
  ariaLabel,
  emptyText,
  disabled = false,
  className = ''
}: {
  labels: readonly TeamTaskLabelRef[];
  selectedIds: ReadonlySet<string>;
  onToggle: (label: TeamTaskLabelRef, selected: boolean) => void;
  ariaLabel: string;
  /** What the popover says when the space has no tags at all. */
  emptyText: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const sorted = useMemo(() => sortTeamTaskLabels(labels), [labels]);
  const term = search.normalize('NFC').trim().toLocaleLowerCase();
  const shown = term
    ? sorted.filter(label => label.name.toLocaleLowerCase().includes(term))
    : sorted;

  // Opening puts focus on the first option, so the arrows work at once.
  useEffect(() => {
    const field = root.current?.querySelector<HTMLElement>('input');
    (field ?? root.current?.querySelector<HTMLElement>('[role="option"]'))?.focus();
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
      {sorted.length >= SEARCH_FROM && (
        <input
          type="search"
          className="team-task-label-menu-search"
          value={search}
          aria-label={t('teamTaskTagSearch')}
          placeholder={t('teamTaskTagSearch')}
          onChange={event => setSearch(event.target.value)}
        />
      )}
      {sorted.length === 0 && (
        <p className="team-task-label-menu-empty" role="presentation">
          {emptyText}
        </p>
      )}
      {sorted.length > 0 && shown.length === 0 && (
        <p className="team-task-label-menu-empty" role="presentation">
          {t('teamTaskTagSearchEmpty')}
        </p>
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
