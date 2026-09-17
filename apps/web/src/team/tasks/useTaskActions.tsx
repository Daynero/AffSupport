import { useMemo } from 'react';
import { Link2, Tag, Trash2, UserRound } from 'lucide-react';
import {
  TEAM_TASK_STATUSES,
  type TeamTaskLabel,
  type TeamTaskStatus,
  type TeamTaskSummary
} from '@video-compressor/shared';
import type { TeamMemberSummary } from '../../api/team';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { MenuEntry } from '../../components/ui/index';
import { TaskStatusIcon, taskStatusLabel } from './TaskStatusControl';

/**
 * What can be done to a task without opening it — one list, two surfaces (024).
 *
 * The board had none of this: a card could be nudged along the status control
 * and nothing else, so assigning five tasks to somebody meant opening five
 * dialogs and closing five dialogs, and deleting a stale one meant opening it
 * to find the button. Meanwhile there was no way to act on more than one task
 * at a time at all.
 *
 * Written as one list for the same reason the material actions are: a card's
 * overflow and the selection bar offering different things, in a different
 * order, is how a person stops trusting either of them. The only difference
 * between the two is the count — one task or seven — which is why `tasks` is
 * an array even when it holds one.
 */

/* The board's own marks, not a second set of circles (024): a menu that draws "in progress" as a
   dotted ring while the card beside it draws a clock teaches two vocabularies for one thing. */
function StatusMark({ status }: { status: TeamTaskStatus }) {
  return (
    <span className={`team-task-menu-status is-${status}`}>
      <TaskStatusIcon status={status} />
    </span>
  );
}

export interface TaskActionHandlers {
  /** Put a link to this one task on the clipboard (024). Absent for a set of them. */
  copyLink?: () => void;
  /** Write a patch to every task in the set. */
  patch: (patch: { status?: TeamTaskStatus; assigneeId?: string | null }) => void;
  /** Hang one tag on every task in the set. */
  tag?: (label: TeamTaskLabel) => void;
  /** Remove them, with the undo the toast carries. */
  remove?: () => void;
}

export function useTaskActions({
  tasks,
  canEdit,
  members,
  labels,
  handlers
}: {
  tasks: readonly TeamTaskSummary[];
  canEdit: boolean;
  members: readonly TeamMemberSummary[];
  labels: readonly TeamTaskLabel[];
  handlers: TaskActionHandlers;
}): MenuEntry[] {
  const { t } = useI18n();
  return useMemo(() => {
    if (!canEdit || tasks.length === 0) return [];
    const entries: MenuEntry[] = [];
    const single = tasks.length === 1 ? tasks[0] : null;

    entries.push({ heading: t('teamTaskStatus') });
    for (const status of TEAM_TASK_STATUSES) {
      entries.push({
        id: `status:${status}`,
        label: taskStatusLabel(status, t),
        icon: <StatusMark status={status} />,
        // A tick only where there is one answer to tick: across seven tasks
        // "done" is a thing to do, not a state the set is in.
        checked: single ? single.status === status : undefined,
        onSelect: () => handlers.patch({ status })
      });
    }

    if (members.length > 0) {
      entries.push({ heading: t('teamTaskAssignee') });
      entries.push({
        id: 'assignee:none',
        label: t('teamTaskUnassigned'),
        icon: <UserRound size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        checked: single ? single.assigneeId === null : undefined,
        onSelect: () => handlers.patch({ assigneeId: null })
      });
      for (const member of members) {
        entries.push({
          id: `assignee:${member.userId}`,
          label: member.displayName ?? member.email ?? member.userId,
          icon: <UserRound size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
          checked: single ? single.assigneeId === member.userId : undefined,
          onSelect: () => handlers.patch({ assigneeId: member.userId })
        });
      }
    }

    if (handlers.tag && labels.length > 0) {
      entries.push({ heading: t('teamTaskTagsLabel') });
      for (const label of labels) {
        entries.push({
          id: `label:${label.id}`,
          label: label.name,
          icon: <Tag size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
          checked: single ? single.labels.some(item => item.id === label.id) : undefined,
          onSelect: () => handlers.tag?.(label)
        });
      }
    }

    if (single && handlers.copyLink) {
      entries.push('separator');
      entries.push({
        id: 'copy-link',
        label: t('teamTaskCopyLink'),
        icon: <Link2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        onSelect: () => handlers.copyLink?.()
      });
    }

    if (handlers.remove) {
      entries.push('separator');
      entries.push({
        id: 'delete',
        label: t('teamTaskDelete'),
        icon: <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        destructive: true,
        onSelect: () => handlers.remove?.()
      });
    }

    return entries;
  }, [canEdit, handlers, labels, members, t, tasks]);
}
