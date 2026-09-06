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
  onChange
}: {
  value: TeamTaskSort;
  onChange: (sort: TeamTaskSort) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="task-sort-control" role="group" aria-label={t('teamTasksSortLabel')}>
      {OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          className={`task-status-filter-option task-sort-option${value === option ? ' is-active' : ''}`}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option === 'date' ? (
            <ArrowDownWideNarrow size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <Tag size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
          <span>{t(option === 'date' ? 'teamTasksSortByDate' : 'teamTasksSortByTag')}</span>
        </button>
      ))}
    </div>
  );
}
