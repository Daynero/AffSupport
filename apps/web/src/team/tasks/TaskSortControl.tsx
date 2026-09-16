/**
 * What the board is ordered by (018): the date a task is for, or its tag.
 *
 * Two presses, in the filter row, because ordering is a filter's neighbour and
 * not a setting: a person who has just narrowed to two tags wants them
 * grouped, and wants the date back a moment later.
 */

import { ArrowDownWideNarrow, Tag } from 'lucide-react';
import type { TeamTaskSort } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';

const OPTIONS: readonly TeamTaskSort[] = ['date', 'label'];

export function TaskSortControl({
  value,
  onChange,
  /**
   * Whether the space has any tags yet.
   *
   * The whole control used to disappear when it did not, so "order by tag"
   * was a feature you could only discover by already having used it. It stays
   * now and says why it cannot be taken — the same rule the material actions
   * follow, and the reason a space with no tags can learn that tags order the
   * board (024, FR-064).
   */
  hasLabels = true
}: {
  value: TeamTaskSort;
  onChange: (sort: TeamTaskSort) => void;
  hasLabels?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="task-sort-control" role="group" aria-label={t('teamTasksSortLabel')}>
      {OPTIONS.map(option => {
        const blocked = option === 'label' && !hasLabels;
        return (
        <button
          key={option}
          type="button"
          className={`task-status-filter-option task-sort-option${value === option ? ' is-active' : ''}`}
          aria-pressed={value === option}
          aria-disabled={blocked || undefined}
          title={blocked ? t('teamTasksSortByTagUnavailable') : undefined}
          onClick={() => {
            if (blocked) return;
            onChange(option);
          }}
        >
          {option === 'date' ? (
            <ArrowDownWideNarrow size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <Tag size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
          <span>{t(option === 'date' ? 'teamTasksSortByDate' : 'teamTasksSortByTag')}</span>
        </button>
        );
      })}
    </div>
  );
}
