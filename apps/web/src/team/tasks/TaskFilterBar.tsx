import { useId, useMemo, type ReactNode } from 'react';
import type { TeamAccountSummary, TeamTaskLabel } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { Chip, SearchField } from '../../components/ui/index';
import { TaskFiltersButton } from './TaskFiltersButton';
import { TaskAccountFilter, taskScopeLabel } from './TaskAccountFilter';
import { TaskLabelFilter } from './TaskLabelFilter';
import { TaskSortControl } from './TaskSortControl';
import { TaskDateFilterControl } from './TaskDateFilter';
import type { TaskAccountScope, TaskDateFilter, TaskStatusFilter } from './useTasks';
import type { TeamTaskSort } from '@video-compressor/shared';

/**
 * The board's filters, in three places instead of nine (024, FR-077).
 *
 * The row used to carry, left to right: four quick-range buttons, a calendar
 * trigger, its clear, an account pill, a tag pill, two sort
 * buttons and four status buttons. Thirteen controls, none of them obviously
 * more important than any other, and on a laptop they wrapped onto two lines
 * before a single task was visible.
 *
 * What is left standing is what a board is actually run on:
 *
 * - **Find**, because the fastest filter is usually a word from the title.
 * - **When**, one trigger; the four quick ranges are presets inside it.
 * - **What state**, because "what is left" is the question a board answers.
 * - **Everything else**, behind one "Filters" surface that says how many are
 *   on — and then says *which* ones, as chips you can take off one at a time.
 *
 * The chips matter more than the surface does: a filter you cannot see is a
 * filter you will blame the data for.
 */
export function TaskFilterBar({
  query,
  onQueryChange,
  date,
  onDateChange,
  status,
  onStatusChange,
  accounts,
  scope,
  onScopeChange,
  labels,
  labelIds,
  onLabelIdsChange,
  sort,
  onSortChange,
  trailing,
  display,
  selection
}: {
  query: string;
  onQueryChange: (value: string) => void;
  date: TaskDateFilter;
  onDateChange: (value: TaskDateFilter) => void;
  status: TaskStatusFilter;
  onStatusChange: (value: TaskStatusFilter) => void;
  accounts: TeamAccountSummary[];
  scope: TaskAccountScope;
  onScopeChange: (value: TaskAccountScope) => void;
  labels: readonly TeamTaskLabel[];
  labelIds: readonly string[];
  onLabelIdsChange: (value: string[]) => void;
  sort: TeamTaskSort;
  onSortChange: (value: TeamTaskSort) => void;
  /** Anything the board wants at the end of the row. */
  trailing?: ReactNode;
  /** How the cards are drawn (024): switches that change the view, not what is on it. */
  display?: ReactNode;
  /**
   * The selection bar, drawn in this row's place while cards are selected — the explorer's
   * way (070, phase 9ж). The row stays laid out under it, unseen and inert, so the bar takes
   * exactly its height: a card a rectangle selects is never pushed out from under it.
   */
  selection?: ReactNode;
}) {
  const { t } = useI18n();
  const headingId = useId();

  /**
   * What is on right now, as things you can take off.
   *
   * Built here rather than by each filter, because a chip's job is to be read
   * together with the others: three chips in a row say "this is why the board
   * looks empty" in a way three separate pills never did.
   */
  const chips = useMemo(() => {
    const active: Array<{ id: string; label: string; clear: () => void }> = [];
    if (scope.kind !== 'all') {
      active.push({
        id: 'scope',
        label: taskScopeLabel(accounts, scope, t('teamTaskAccountFilter')),
        clear: () => onScopeChange({ kind: 'all' })
      });
    }
    for (const id of labelIds) {
      const label = labels.find(item => item.id === id);
      if (!label) continue;
      active.push({
        id: `label:${id}`,
        label: label.name,
        clear: () => onLabelIdsChange(labelIds.filter(value => value !== id))
      });
    }
    return active;
  }, [accounts, labelIds, labels, onLabelIdsChange, onScopeChange, scope, t]);

  return (
    <div className="task-filter-bar">
      <div className={`team-board-controls${selection ? ' is-selecting' : ''}`}>
        <div className="task-filter-row" inert={selection ? true : undefined}>
          {/* The inventory's search box (070, T079): the raw field inherited the panel's body
            size and set its placeholder at 20px, taller than every control beside it. */}
          <SearchField
            className="task-board-search"
            aria-label={t('teamTasksSearch')}
            placeholder={t('teamTasksSearch')}
            clearLabel={t('teamSearchClear')}
            value={query}
            onChange={onQueryChange}
          />
          <TaskDateFilterControl
            value={date}
            onChange={onDateChange}
            status={status}
            onStatusChange={onStatusChange}
            inlineDays
            size="sm"
          >
            <TaskFiltersButton count={chips.length} size="sm">
              {/* Three kinds of thing, named apart the way Linear parts Filter
                  from Display: what is shown, in what order, and how the cards
                  are drawn. One column, every control the panel's full width,
                  a hairline between the sections. */}
              {(accounts.length > 0 ||
                scope.kind !== 'all' ||
                labels.length > 0 ||
                labelIds.length > 0) && (
                <div
                  className="task-filter-section"
                  role="group"
                  aria-labelledby={`${headingId}-show`}
                >
                  <span id={`${headingId}-show`} className="task-filter-heading">
                    {t('teamTasksFilterGroup')}
                  </span>
                  {(accounts.length > 0 || scope.kind !== 'all') && (
                    <TaskAccountFilter accounts={accounts} scope={scope} onChange={onScopeChange} />
                  )}
                  {(labels.length > 0 || labelIds.length > 0) && (
                    <TaskLabelFilter
                      labels={labels}
                      selectedIds={labelIds}
                      onChange={onLabelIdsChange}
                    />
                  )}
                </div>
              )}
              <div
                className="task-filter-section"
                role="group"
                aria-labelledby={`${headingId}-sort`}
              >
                <span id={`${headingId}-sort`} className="task-filter-heading">
                  {t('teamTasksSortGroup')}
                </span>
                <TaskSortControl
                  value={sort}
                  onChange={onSortChange}
                  hasLabels={labels.length > 0}
                />
              </div>
              {display && (
                <div
                  className="task-filter-section"
                  role="group"
                  aria-labelledby={`${headingId}-view`}
                >
                  <span id={`${headingId}-view`} className="task-filter-heading">
                    {t('teamTasksDisplayGroup')}
                  </span>
                  <div className="task-filter-display">{display}</div>
                </div>
              )}
            </TaskFiltersButton>
            {trailing}
          </TaskDateFilterControl>
        </div>
        {selection}
      </div>
      {chips.length > 0 && (
        <div className="task-filter-chips" aria-label={t('teamTasksActiveFilters')}>
          {chips.map(chip => (
            <Chip
              key={chip.id}
              color="secondary"
              className="task-filter-chip"
              onRemove={chip.clear}
              removeLabel={t('teamTasksRemoveFilter', { name: chip.label })}
            >
              {chip.label}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
