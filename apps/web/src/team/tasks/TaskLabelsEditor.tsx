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

import { useEffect, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  sortTeamTaskLabels,
  type TeamTaskLabel,
  type TeamTaskLabelRef
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { TaskLabelChip } from '../labels/TaskLabelChip';
import { TaskLabelMenu } from '../labels/TaskLabelMenu';

export interface TaskLabelsEditorClient {
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
  onLabelsChange
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

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Ours, not the dialog's: the popover closes, the editor stays.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

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

  const toggle = (label: TeamTaskLabelRef, next: boolean) =>
    void run(async () => {
      onLabelsChange(
        next
          ? await client.attachTaskLabel({ teamId, taskId, labelId: label.id })
          : await client.detachTaskLabel({ teamId, taskId, labelId: label.id })
      );
    });

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
        {open && canEdit && (
          <TaskLabelMenu
            labels={available}
            selectedIds={attached}
            disabled={busy}
            ariaLabel={t('teamTaskTagsLabel')}
            emptyText={t('teamTaskTagsNoneYet')}
            onToggle={toggle}
          />
        )}
      </div>
    </div>
  );
}
