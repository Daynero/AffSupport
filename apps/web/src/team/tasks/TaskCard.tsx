import type { TeamTaskSummary } from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

export function TaskCard({ task, onOpen }: { task: TeamTaskSummary; onOpen: () => void }) {
  const { t } = useI18n();
  const ratio = task.progressValue / Math.max(task.progressMax, 1);
  const statusLabel =
    task.status === 'todo'
      ? t('teamTaskStatusTodo')
      : task.status === 'in_progress'
        ? t('teamTaskStatusInProgress')
        : t('teamTaskStatusDone');
  return (
    <article className="team-task-card" data-status={task.status}>
      <div className="team-task-card-heading">
        <div>
          <small>{statusLabel}</small>
          <h3>{task.title}</h3>
        </div>
        <strong>
          {task.progressValue}/{task.progressMax}
        </strong>
      </div>
      <div
        className="team-task-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={task.progressMax}
        aria-valuenow={task.progressValue}
      >
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      {task.note && <p>{task.note}</p>}
      <div className="team-task-card-footer">
        <span>{t('teamTaskAttachmentsCount', { count: task.attachmentCount })}</span>
        {task.assigneeLabelSnapshot && <span>{task.assigneeLabelSnapshot}</span>}
        <Button type="button" variant="ghost" onClick={onOpen}>
          {t('teamTaskOpen')}
        </Button>
      </div>
    </article>
  );
}
