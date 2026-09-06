/**
 * Narrowing the board to a set of tags (018).
 *
 * A pill in the filter row beside the dates, the accounts and the statuses.
 * Several tags at once, and a task matching any of them stays: the filter is
 * opened to gather work — "everything hot or urgent" — not to intersect it.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { sortTeamTaskLabels, type TeamTaskLabel } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { TaskLabelMenu } from '../labels/TaskLabelMenu';

export function TaskLabelFilter({
  labels,
  selectedIds,
  onChange
}: {
  labels: readonly TeamTaskLabel[];
  selectedIds: readonly string[];
  onChange: (labelIds: string[]) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = new Set(selectedIds);
  const active = selectedIds.length > 0;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  /** What the pill says: the tag, the first one and how many more, or the word. */
  const chosen = sortTeamTaskLabels(labels.filter(label => selected.has(label.id)));
  const label =
    chosen.length === 0
      ? t('teamTaskTagFilter')
      : chosen.length === 1
        ? chosen[0]!.name
        : `${chosen[0]!.name} +${chosen.length - 1}`;

  return (
    <div ref={root} className="task-account-filter task-label-filter">
      <button
        ref={trigger}
        type="button"
        className={`task-status-filter-option task-account-filter-trigger${active ? ' is-active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('teamTaskTagFilterLabel')}
        data-color={chosen.length === 1 ? chosen[0]!.color : undefined}
        onClick={() => setOpen(current => !current)}
      >
        <span>{label}</span>
        {!active && <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      </button>
      {active && (
        <button
          type="button"
          className="task-date-filter-clear"
          aria-label={t('teamTaskTagFilterClear')}
          onClick={() => {
            onChange([]);
            setOpen(false);
            window.requestAnimationFrame(() => trigger.current?.focus());
          }}
        >
          <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      )}
      {open && (
        <TaskLabelMenu
          labels={labels}
          selectedIds={selected}
          ariaLabel={t('teamTaskTagFilterLabel')}
          emptyText={t('teamTaskTagsNoneYet')}
          onToggle={(label, next) =>
            onChange(next ? [...selectedIds, label.id] : selectedIds.filter(id => id !== label.id))
          }
        />
      )}
    </div>
  );
}
