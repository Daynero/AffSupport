import { useCallback } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useOptionalToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute } from '../routes';
import { TaskChooserDialog } from '../tasks/TaskChooserDialog';

export interface LaunchesToTaskClient {
  listTasks: (input: { teamId: string; pageSize?: number }) => Promise<TeamTaskSummary[]>;
  attachTaskLaunches: (input: {
    teamId: string;
    taskId: string;
    launchIds: string[];
  }) => Promise<{ attached: string[]; alreadyAttached: string[] }>;
  createTaskWithLaunches: (input: {
    teamId: string;
    title: string;
    launchIds: string[];
  }) => Promise<TeamTaskSummary>;
}

/** The task's own address, for «Open the task». */
export function taskHref(teamId: string, taskId: string): string {
  return buildTeamRoute({ spaceId: teamId, section: 'tasks', query: { taskId } });
}

/**
 * 076 US1 — selected launches go into a task: one that exists, or a new one named
 * on the spot. The launches stay where they are; the toast is the way to the task.
 */
export function LaunchesToTaskDialog({
  teamId,
  launchIds,
  client = teamApi,
  onDone,
  onClose
}: {
  teamId: string;
  launchIds: readonly string[];
  client?: LaunchesToTaskClient;
  /** After the launches are in the task: the board clears its selection and refreshes chips. */
  onDone: (taskId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toasts = useOptionalToasts();
  const listTasks = useCallback(
    (input: { teamId: string; pageSize?: number }) => client.listTasks(input),
    [client]
  );
  const ids = [...launchIds];

  const finish = (taskId: string, text: string, tone: 'success' | 'info') => {
    onClose();
    onDone(taskId);
    toasts?.push({
      tone,
      text,
      action: { label: t('teamAddToTaskOpen'), run: () => navigateTo(taskHref(teamId, taskId)) }
    });
  };

  return (
    <TaskChooserDialog
      teamId={teamId}
      heading={t('launchesToTaskTitle', { count: ids.length })}
      listTasks={listTasks}
      onChoose={async task => {
        try {
          const result = await client.attachTaskLaunches({
            teamId,
            taskId: task.id,
            launchIds: ids
          });
          finish(
            task.id,
            result.attached.length > 0
              ? t('launchesToTaskDone', { count: result.attached.length, task: task.title })
              : t('launchesToTaskAlready', { task: task.title }),
            result.attached.length > 0 ? 'success' : 'info'
          );
        } catch (cause) {
          toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        }
      }}
      onCreate={async title => {
        try {
          const created = await client.createTaskWithLaunches({ teamId, title, launchIds: ids });
          finish(
            created.id,
            t('launchesToTaskCreated', { count: ids.length, task: created.title }),
            'success'
          );
        } catch (cause) {
          toasts?.push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        }
      }}
      onClose={onClose}
    />
  );
}
