/**
 * What the board is ordered by (018): the date a task is for, or its tag.
 *
 * A choice of one, so it is the inventory's segmented control (024): two
 * options on one track, arrow keys between them, a single tab stop. It sits
 * in the "Filters" panel under its own heading, because ordering is a
 * filter's neighbour and not a setting: a person who has just narrowed to two
 * tags wants them grouped, and wants the date back a moment later.
 */

import { ArrowDownWideNarrow, Tag } from 'lucide-react';
import type { TeamTaskSort } from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { SegmentedControl } from '../../components/ui/index';

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
    <SegmentedControl<TeamTaskSort>
      size="sm"
      label={t('teamTasksSortLabel')}
      className="task-sort-control"
      value={value}
      onChange={onChange}
      options={[
        {
          value: 'date',
          label: (
            <>
              <ArrowDownWideNarrow size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{t('teamTasksSortByDate')}</span>
            </>
          )
        },
        {
          value: 'label',
          disabled: !hasLabels,
          title: hasLabels ? undefined : t('teamTasksSortByTagUnavailable'),
          label: (
            <>
              <Tag size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{t('teamTasksSortByTag')}</span>
            </>
          )
        }
      ]}
    />
  );
}
