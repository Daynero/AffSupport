import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { TeamTaskPatch, TeamTaskStatus, TeamTaskSummary } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { TaskProgressScale } from './TaskProgressScale';
import { TaskStatusControl } from './TaskStatusControl';

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, [role="slider"]'));
}

export function TaskCard({
  task,
  canEdit,
  onOpen,
  onUpdate
}: {
  task: TeamTaskSummary;
  canEdit: boolean;
  onOpen: () => void;
  onUpdate: (patch: TeamTaskPatch) => Promise<TeamTaskSummary>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TeamTaskStatus>(task.status);
  const [progressValue, setProgressValue] = useState(task.progressValue);
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setStatus(task.status);
    setProgressValue(task.progressValue);
  }, [task.progressValue, task.status, task.updatedAt]);

  const update = async (patch: TeamTaskPatch, reset: () => void) => {
    if (!canEdit || updating) return;
    setUpdating(true);
    setFailed(false);
    try {
      await onUpdate(patch);
    } catch {
      reset();
      setFailed(true);
    } finally {
      setUpdating(false);
    }
  };

  const openFromClick = (event: MouseEvent<HTMLElement>) => {
    if (!isInteractiveTarget(event.target)) onOpen();
  };
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <article
      className="team-task-card"
      data-status={status}
      tabIndex={0}
      aria-label={t('teamTaskOpenCard', { name: task.title })}
      onClick={openFromClick}
      onKeyDown={openFromKeyboard}
    >
      <div className="team-task-card-heading">
        <TaskStatusControl
          compact
          value={status}
          disabled={!canEdit || updating}
          onChange={next => {
            if (next === status) return;
            const previous = status;
            setStatus(next);
            void update({ status: next }, () => setStatus(previous));
          }}
        />
        {task.assigneeLabelSnapshot && (
          <span className="team-task-assignee">{task.assigneeLabelSnapshot}</span>
        )}
      </div>
      <h3 title={task.title}>{task.title}</h3>
      <TaskProgressScale
        value={progressValue}
        max={task.progressMax}
        label={t('teamTaskProgressScale')}
        disabled={!canEdit || updating}
        onChange={setProgressValue}
        onCommit={next => {
          const previous = task.progressValue;
          void update({ progressValue: next }, () => setProgressValue(previous));
        }}
      />
      <div className="team-task-card-description">
        {task.note ? <p>{task.note}</p> : <span>{t('teamTaskDescriptionEmpty')}</span>}
      </div>
      <div className="team-task-card-footer">
        <span>{t('teamTaskAttachmentsCount', { count: task.attachmentCount })}</span>
        {failed && <span className="team-task-card-error">{t('teamTaskSaveFailed')}</span>}
      </div>
    </article>
  );
}
