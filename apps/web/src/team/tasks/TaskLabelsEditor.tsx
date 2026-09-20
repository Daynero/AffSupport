/**
 * The tag row in the task editor (018).
 *
 * Chips with a × each, and one button that opens the space's dictionary. A tag
 * is written the moment it is pressed, like the status and unlike the title:
 * it is a fact about the task, not a draft of one, and a person who tags three
 * tasks and closes the last editor with Escape should not lose all three.
 *
 * The dictionary itself is not editable from here on purpose — tags are made
 * in the space's settings, so a picker cannot fill the list with near-
 * duplicates typed in a hurry. When the space has none, the popover says where
 * they come from.
 */

import { useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  sortTeamTaskLabels,
  TEAM_TASK_LABEL_DEFAULT_COLOR,
  type TeamTaskLabel,
  type TeamTaskLabelColor,
  type TeamTaskLabelRef
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { TaskLabelChip } from '../labels/TaskLabelChip';
import { TaskLabelMenu } from '../labels/TaskLabelMenu';
import { Popover } from '../../components/ui/index';

export interface TaskLabelsEditorClient {
  /**
   * Make a tag from inside the task (024, FR-071).
   *
   * Optional: where it is missing the picker falls back to pointing at the
   * settings tab, which is what every surface did before.
   */
  createTaskLabel?: (input: {
    teamId: string;
    name: string;
    color: TeamTaskLabelColor;
  }) => Promise<TeamTaskLabel>;
  attachTaskLabel(input: {
    teamId: string;
    taskId: string;
    labelId: string;
  }): Promise<TeamTaskLabelRef[]>;
  detachTaskLabel(input: {
    teamId: string;
    taskId: string;
    labelId: string;
  }): Promise<TeamTaskLabelRef[]>;
}

export function TaskLabelsEditor({
  teamId,
  taskId,
  labels,
  available,
  canEdit,
  client,
  onLabelsChange,
  onLabelCreated
}: {
  teamId: string;
  taskId: string;
  /** The tags this task carries. */
  labels: readonly TeamTaskLabelRef[];
  /** The space's dictionary, as the settings tab keeps it. */
  available: readonly TeamTaskLabel[];
  canEdit: boolean;
  client: TaskLabelsEditorClient;
  onLabelsChange: (labels: TeamTaskLabelRef[]) => void;
  /** So the space's dictionary picks up a tag made from in here. */
  onLabelCreated?: (label: TeamTaskLabel) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const labelId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sorted = sortTeamTaskLabels(labels);
  const attached = new Set(labels.map(label => label.id));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  /*
   * A pick closes the list (the owner, 024): a tag is hung one at a time, and the
   * list left open after the press read as the press not having taken.
   */
  const toggle = (label: TeamTaskLabelRef, next: boolean) => {
    setOpen(false);
    trigger.current?.focus();
    void run(async () => {
      onLabelsChange(
        next
          ? await client.attachTaskLabel({ teamId, taskId, labelId: label.id })
          : await client.detachTaskLabel({ teamId, taskId, labelId: label.id })
      );
    });
  };

  /**
   * The word typed into the picker, made into a tag and hung on the task.
   *
   * One press does both, because "create it" and "use it" were never two
   * separate intentions — nobody makes a tag in order to look at it.
   */
  const create = async (name: string): Promise<TeamTaskLabelRef | null> => {
    const make = client.createTaskLabel;
    if (!make) return null;
    try {
      setBusy(true);
      const made = await make({ teamId, name, color: TEAM_TASK_LABEL_DEFAULT_COLOR });
      onLabelsChange(await client.attachTaskLabel({ teamId, taskId, labelId: made.id }));
      onLabelCreated?.(made);
      setOpen(false);
      return made;
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const detach = (label: TeamTaskLabelRef) =>
    void run(async () => {
      onLabelsChange(await client.detachTaskLabel({ teamId, taskId, labelId: label.id }));
      push({
        tone: 'info',
        text: t('teamTaskTagRemoved', { name: label.name }),
        action: {
          label: t('teamUndo'),
          run: async () => {
            try {
              onLabelsChange(await client.attachTaskLabel({ teamId, taskId, labelId: label.id }));
            } catch (cause) {
              push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            }
          }
        }
      });
    });

  return (
    <div className="team-task-labels-row-editor" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="team-task-accounts-label">
        {t('teamTaskTagsLabel')}
      </span>
      <div ref={root} className="team-task-label-chips is-editing">
        {sorted.map(label => (
          <TaskLabelChip
            key={label.id}
            label={label}
            disabled={busy || !canEdit}
            onRemove={canEdit ? () => detach(label) : undefined}
          />
        ))}
        {/* Nothing is said when nothing is chosen: "+ Tag" beside an empty row
            already says both that it is empty and what to do. */}
        {canEdit && (
          <button
            ref={trigger}
            type="button"
            className="team-task-account-add"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen(current => !current)}
          >
            <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('teamTaskTagAddToTask')}
          </button>
        )}
        <Popover
          open={open && canEdit}
          /* The tag list closes, the task editor it sits in stays: the shared
             stack gives Escape to the innermost surface. */
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
          anchor={root}
          placement="bottom-start"
          frequent
          label={t('teamTaskTagsLabel')}
          className="team-task-label-menu-popover"
        >
          <TaskLabelMenu
            labels={available}
            selectedIds={attached}
            disabled={busy}
            ariaLabel={t('teamTaskTagsLabel')}
            emptyText={t('teamTaskTagsNoneYet')}
            emptyTarget={{ kind: 'settings', tab: 'tags' }}
            onCreate={canEdit && client.createTaskLabel ? create : undefined}
            onToggle={toggle}
          />
        </Popover>
      </div>
    </div>
  );
}
