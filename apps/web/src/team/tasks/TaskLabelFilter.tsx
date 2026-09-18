/**
 * Narrowing the board to a set of tags (018).
 *
 * A field in the "Filters" panel (024), under the account and the assignee.
 * Several tags at once, and a task matching any of them stays: the filter is
 * opened to gather work — "everything hot or urgent" — not to intersect it.
 */

import { useRef, useState } from 'react';
import { sortTeamTaskLabels, type TeamTaskLabel } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { TaskLabelMenu } from '../labels/TaskLabelMenu';
import { Popover } from '../../components/ui/index';
import { TaskFilterField } from './TaskFilterField';

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

  /**
   * What the field says: the tag in its own colour, the first one and how
   * many more, or the word for "any".
   */
  const chosen = sortTeamTaskLabels(labels.filter(label => selected.has(label.id)));
  const value =
    chosen.length === 0
      ? t('teamTaskTagFilterAll')
      : chosen.length === 1
        ? chosen[0]!.name
        : `${chosen[0]!.name} +${chosen.length - 1}`;
  const marker =
    chosen.length === 1 ? (
      <span className="task-filter-field-dot" data-color={chosen[0]!.color} aria-hidden="true" />
    ) : undefined;

  return (
    <TaskFilterField
      rootRef={root}
      triggerRef={trigger}
      className="task-label-filter"
      name={t('teamTaskTagFilter')}
      value={value}
      marker={marker}
      active={active}
      open={open}
      label={t('teamTaskTagFilterLabel')}
      clearLabel={t('teamTaskTagFilterClear')}
      onToggle={() => setOpen(current => !current)}
      onClear={() => {
        onChange([]);
        setOpen(false);
        window.requestAnimationFrame(() => trigger.current?.focus());
      }}
    >
      <Popover
        open={open}
        /* Escape and an outside press close onto the trigger, so a keyboard
           is never left inside a menu that is no longer on screen. */
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
        }}
        anchor={root}
        placement="bottom-start"
        frequent
        label={t('teamTaskTagFilterLabel')}
        className="team-task-label-menu-popover"
      >
        <TaskLabelMenu
          labels={labels}
          selectedIds={selected}
          ariaLabel={t('teamTaskTagFilterLabel')}
          emptyText={t('teamTaskTagsNoneYet')}
          emptyTarget={{ kind: 'settings', tab: 'tags' }}
          onToggle={(label, next) =>
            onChange(next ? [...selectedIds, label.id] : selectedIds.filter(id => id !== label.id))
          }
        />
      </Popover>
    </TaskFilterField>
  );
}
