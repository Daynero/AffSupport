import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  TeamTaskAttachmentSummary,
  TeamTaskPatch,
  TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import { TaskAttachmentPicker, type TaskAttachmentPickerClient } from './TaskAttachmentPicker';
import { TaskAttachmentTile, type TaskAttachmentPreviewClient } from './TaskAttachmentTile';
import { TaskProgressScale } from './TaskProgressScale';
import { TaskStatusControl } from './TaskStatusControl';

export interface TaskEditorClient extends TaskAttachmentPickerClient, TaskAttachmentPreviewClient {
  getTask(input: {
    teamId: string;
    taskId: string;
    attachmentCursor?: number | null;
    attachmentPageSize?: number;
  }): Promise<{ task: TeamTaskSummary; attachments: TeamTaskAttachmentSummary[] }>;
  updateTask(teamId: string, taskId: string, patch: TeamTaskPatch): Promise<TeamTaskSummary>;
  detachTaskMaterial(teamId: string, taskId: string, materialId: string): Promise<boolean>;
}

const defaultClient: TaskEditorClient = teamApi;

function uniqueAttachments(
  current: TeamTaskAttachmentSummary[],
  incoming: TeamTaskAttachmentSummary[]
) {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.position - right.position);
}

export function TaskEditor({
  teamId,
  task: initialTask,
  members,
  canEdit,
  client = defaultClient,
  onClose,
  onChanged
}: {
  teamId: string;
  task: TeamTaskSummary;
  members: TeamMemberSummary[];
  canEdit: boolean;
  client?: TaskEditorClient;
  onClose: () => void;
  onChanged: (task: TeamTaskSummary) => void;
}) {
  const { t } = useI18n();
  const [task, setTask] = useState(initialTask);
  const [title, setTitle] = useState(initialTask.title);
  const [note, setNote] = useState(initialTask.note ?? '');
  const [status, setStatus] = useState(initialTask.status);
  const [assigneeId, setAssigneeId] = useState(initialTask.assigneeId ?? '');
  const [progressMax, setProgressMax] = useState(initialTask.progressMax);
  const [progressValue, setProgressValue] = useState(initialTask.progressValue);
  const [attachments, setAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const hydrateTask = (next: TeamTaskSummary) => {
    setTask(next);
    setTitle(next.title);
    setNote(next.note ?? '');
    setStatus(next.status);
    setAssigneeId(next.assigneeId ?? '');
    setProgressMax(next.progressMax);
    setProgressValue(next.progressValue);
  };

  const load = useCallback(
    async ({ hydrate = false }: { hydrate?: boolean } = {}) => {
      setLoading(true);
      try {
        const value = await client.getTask({ teamId, taskId: task.id, attachmentPageSize: 50 });
        if (hydrate) hydrateTask(value.task);
        else setTask(value.task);
        setAttachments(value.attachments);
        setError(false);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [client, task.id, teamId]
  );

  useEffect(() => {
    void load({ hydrate: true });
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(false);
    try {
      const updated = await client.updateTask(teamId, task.id, {
        title,
        note: note || null,
        status,
        assigneeId: assigneeId || null,
        progressMax,
        progressValue,
        expectedUpdatedAt: task.updatedAt
      });
      onChanged(updated);
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const loadMore = async () => {
    const cursor = attachments.at(-1)?.position;
    if (cursor === undefined) return;
    setLoadingMore(true);
    try {
      const value = await client.getTask({
        teamId,
        taskId: task.id,
        attachmentCursor: cursor,
        attachmentPageSize: 50
      });
      setTask(value.task);
      setAttachments(current => uniqueAttachments(current, value.attachments));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Modal
      labelledBy="team-task-editor-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#team-task-title"
      size="lg"
    >
      <div className="team-task-editor">
        <form className="team-dialog-form" onSubmit={event => void save(event)}>
          <div>
            <p className="team-workspace-eyebrow">{t('teamTasksEyebrow')}</p>
            <h2 id="team-task-editor-title">{t('teamTaskEditTitle')}</h2>
          </div>
          <section className="team-task-editor-status" aria-labelledby="team-task-status-title">
            <span id="team-task-status-title">{t('teamTaskStatus')}</span>
            <TaskStatusControl value={status} disabled={!canEdit} onChange={setStatus} />
          </section>
          <label>
            <span>{t('teamTaskTitle')}</span>
            <input
              id="team-task-title"
              value={title}
              maxLength={160}
              required
              disabled={!canEdit}
              onChange={event => setTitle(event.target.value)}
            />
          </label>
          <div className="team-task-editor-fields">
            <label>
              <span>{t('teamTaskAssignee')}</span>
              <select
                value={assigneeId}
                disabled={!canEdit}
                onChange={event => setAssigneeId(event.target.value)}
              >
                <option value="">{t('teamTaskUnassigned')}</option>
                {members.map(member => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName ?? member.email ?? member.userId}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <section className="team-task-editor-progress" aria-labelledby="team-task-progress-title">
            <span id="team-task-progress-title">{t('teamTaskProgressScale')}</span>
            <TaskProgressScale
              value={progressValue}
              max={progressMax}
              disabled={!canEdit}
              label={t('teamTaskProgressScale')}
              onChange={setProgressValue}
            />
          </section>
          <label>
            <span>{t('teamTaskDescription')}</span>
            <textarea
              className="team-task-description-input"
              value={note}
              maxLength={2_000}
              disabled={!canEdit}
              onChange={event => setNote(event.target.value)}
            />
          </label>
          {error && <p className="team-inline-error">{t('teamTaskSaveFailed')}</p>}
          {canEdit && (
            <div className="team-dialog-actions">
              <Button type="submit" variant="primary" loading={saving}>
                {t('teamTaskSave')}
              </Button>
            </div>
          )}
        </form>

        <section className="team-task-attachments" aria-labelledby="team-task-attachments-title">
          <div className="team-task-attachments-heading">
            <div>
              <h3 id="team-task-attachments-title">{t('teamTaskAttachments')}</h3>
              <p>{t('teamTaskAttachmentsHint')}</p>
            </div>
            <span>{t('teamTaskAttachmentsCount', { count: task.attachmentCount })}</span>
          </div>
          {loading && <p aria-live="polite">{t('teamTaskLoading')}</p>}
          {!loading && attachments.length === 0 && <p>{t('teamTaskAttachmentsEmpty')}</p>}
          <div className="team-task-attachment-grid">
            {attachments.map(attachment => (
              <TaskAttachmentTile
                key={attachment.id}
                teamId={teamId}
                attachment={attachment}
                client={client}
                onDetach={
                  canEdit
                    ? () => {
                        void client
                          .detachTaskMaterial(teamId, task.id, attachment.materialId)
                          .then(() => void load())
                          .catch(() => setError(true));
                      }
                    : undefined
                }
              />
            ))}
          </div>
          {attachments.length < task.attachmentCount && (
            <Button
              type="button"
              variant="secondary"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('teamTaskLoadMoreAttachments')}
            </Button>
          )}
        </section>

        {canEdit && (
          <TaskAttachmentPicker
            teamId={teamId}
            taskId={task.id}
            client={client}
            onAttached={() => void load()}
          />
        )}
      </div>
    </Modal>
  );
}
