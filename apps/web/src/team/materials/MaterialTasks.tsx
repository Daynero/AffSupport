import { useEffect, useState } from 'react';
import { ListPlus } from 'lucide-react';
import type { TeamTaskStatus } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { useOptionalAddToTask } from '../tasks/AddToTask';
import { TaskStatusIcon, taskStatusLabel } from '../tasks/TaskStatusControl';

export interface MaterialTasksClient {
  listMaterialTasks?: (
    teamId: string,
    materialId: string
  ) => Promise<Array<{ id: string; title: string; status: TeamTaskStatus }>>;
}

/**
 * The tasks a file is on, in its details card (024).
 *
 * "Which launch used this creative?" was a walk through tasks one by one. The card lists them —
 * open first — each a way to its task, with "Add to a task" beside, so the file knows where it
 * is used and can be used once more without leaving Files.
 */
export function MaterialTasks({
  teamId,
  material,
  revision = 0,
  client = teamApi
}: {
  teamId: string;
  material: { id: string; name: string };
  revision?: number;
  client?: MaterialTasksClient;
}) {
  const { t } = useI18n();
  const addToTask = useOptionalAddToTask();
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; status: TeamTaskStatus }>>(
    []
  );

  useEffect(() => {
    if (!client.listMaterialTasks) return;
    let active = true;
    void client
      .listMaterialTasks(teamId, material.id)
      .then(value => {
        if (active) setTasks(value);
      })
      .catch(() => {
        if (active) setTasks([]);
      });
    return () => {
      active = false;
    };
  }, [client, material.id, revision, teamId]);

  if (tasks.length === 0 && !addToTask) return null;

  return (
    <div className="material-tasks">
      {tasks.length > 0 && (
        <>
          <span className="material-tasks-caption">{t('materialInTasks')}</span>
          <ul>
            {tasks.map(task => {
              const href = buildTeamRoute({
                spaceId: teamId,
                section: 'tasks',
                query: { taskId: task.id }
              });
              return (
                <li key={task.id} className={`is-${task.status}`}>
                  <a href={href} title={task.title} onClick={event => internalLink(event, href)}>
                    <span
                      className="material-tasks-status"
                      aria-label={taskStatusLabel(task.status, t)}
                    >
                      <TaskStatusIcon status={task.status} />
                    </span>
                    <span className="material-tasks-title">{task.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {addToTask && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="material-tasks-add"
          onClick={() => addToTask([{ id: material.id, name: material.name }])}
        >
          <ListPlus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('materialActionAddToTask')}
        </Button>
      )}
    </div>
  );
}
