import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { TeamAccountSummary, TeamTaskLabel } from '@video-compressor/shared';
import type { TeamMemberSummary } from '../../api/team';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { Popover } from '../../components/ui/index';
import { TaskAccountFilter, taskScopeLabel } from './TaskAccountFilter';
import { TaskAssigneeFilter } from './TaskAssigneeFilter';
import { TaskLabelFilter } from './TaskLabelFilter';
import { TaskSortControl } from './TaskSortControl';
import { TaskDateFilterControl } from './TaskDateFilter';
import type {
  TaskAccountScope,
  TaskAssigneeFilter as AssigneeFilter,
  TaskDateFilter,
  TaskStatusFilter
} from './useTasks';
import type { TeamTaskSort } from '@video-compressor/shared';

/**
 * The board's filters, in three places instead of nine (024, FR-077).
 *
 * The row used to carry, left to right: four quick-range buttons, a calendar
 * trigger, its clear, an account pill, an assignee pill, a tag pill, two sort
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
  members,
  assignee,
  onAssigneeChange,
  labels,
  labelIds,
  onLabelIdsChange,
  sort,
  onSortChange,
  trailing
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
  members: readonly TeamMemberSummary[];
  assignee: AssigneeFilter;
  onAssigneeChange: (value: AssigneeFilter) => void;
  labels: readonly TeamTaskLabel[];
  labelIds: readonly string[];
  onLabelIdsChange: (value: string[]) => void;
  sort: TeamTaskSort;
  onSortChange: (value: TeamTaskSort) => void;
  /** Anything the board wants at the end of the row. */
  trailing?: ReactNode;
}) {
  const { t } = useI18n();
  const filtersRoot = useRef<HTMLDivElement | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    if (assignee.kind !== 'all') {
      const member =
        assignee.kind === 'member'
          ? members.find(item => item.userId === assignee.userId)
          : undefined;
      active.push({
        id: 'assignee',
        label:
          assignee.kind === 'unassigned'
            ? t('teamTaskUnassigned')
            : (member?.displayName ?? member?.email ?? t('teamTaskAssignee')),
        clear: () => onAssigneeChange({ kind: 'all' })
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
  }, [
    accounts,
    assignee,
    labelIds,
    labels,
    members,
    onAssigneeChange,
    onLabelIdsChange,
    onScopeChange,
    scope,
    t
  ]);

  return (
    <div className="task-filter-bar">
      <div className="task-filter-row">
        <div className="task-filter-search">
          <Search size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            type="search"
            value={query}
            aria-label={t('teamTasksSearch')}
            placeholder={t('teamTasksSearch')}
            onChange={event => onQueryChange(event.target.value)}
          />
        </div>
        <TaskDateFilterControl
          value={date}
          onChange={onDateChange}
          status={status}
          onStatusChange={onStatusChange}
        >
          <div ref={filtersRoot} className="task-filter-more">
            <button
              type="button"
              className={`task-quick-range${chips.length > 0 ? ' is-active' : ''}`}
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(current => !current)}
            >
              <SlidersHorizontal size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{t('teamTasksMoreFilters')}</span>
            </button>
            <Popover
              open={filtersOpen}
              onClose={() => setFiltersOpen(false)}
              anchor={filtersRoot}
              placement="bottom-start"
              frequent
              label={t('teamTasksMoreFilters')}
              className="task-filter-more-popover"
            >
              {/* Two kinds of thing, named apart the way Linear parts Filter from Display:
                  what is shown, then in what order. As one unlabelled stack an
                  account picker sat on top of a sort toggle and read as one control. */}
              {(accounts.length > 0 ||
                scope.kind !== 'all' ||
                members.length > 1 ||
                assignee.kind !== 'all' ||
                labels.length > 0 ||
                labelIds.length > 0) && (
                <span className="task-filter-more-caption">{t('teamTasksFilterGroup')}</span>
              )}
              {(accounts.length > 0 || scope.kind !== 'all') && (
                <TaskAccountFilter accounts={accounts} scope={scope} onChange={onScopeChange} />
              )}
              {/* A space of one has nobody to filter by (024, FR-089); a filter
                  already in force stays visible, so it can be taken off. */}
              {(members.length > 1 || assignee.kind !== 'all') && (
                <TaskAssigneeFilter
                  members={members}
                  value={assignee}
                  onChange={onAssigneeChange}
                />
              )}
              {(labels.length > 0 || labelIds.length > 0) && (
                <TaskLabelFilter
                  labels={labels}
                  selectedIds={labelIds}
                  onChange={onLabelIdsChange}
                />
              )}
              <span className="task-filter-more-caption">{t('teamTasksSortGroup')}</span>
              <TaskSortControl value={sort} onChange={onSortChange} hasLabels={labels.length > 0} />
            </Popover>
          </div>
          {trailing}
        </TaskDateFilterControl>
      </div>
      {chips.length > 0 && (
        <div className="task-filter-chips" aria-label={t('teamTasksActiveFilters')}>
          {chips.map(chip => (
            <button
              key={chip.id}
              type="button"
              className="task-filter-chip"
              onClick={chip.clear}
              aria-label={t('teamTasksRemoveFilter', { name: chip.label })}
            >
              <span>{chip.label}</span>
              <X size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
