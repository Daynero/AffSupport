import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  TeamTaskAttachmentSummary,
  TeamTaskPatch,
  TeamTaskSummary
} from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  attachTaskMaterialsInChunks,
  TaskAttachmentPicker,
  type TaskAttachmentCandidate,
  type TaskAttachmentPickerClient
} from './TaskAttachmentPicker';
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
const TASK_PROGRESS_MAX = 10_000;

function uniqueAttachments(
  current: TeamTaskAttachmentSummary[],
  incoming: TeamTaskAttachmentSummary[]
) {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.position - right.position);
}

function draftAttachment(
  taskId: string,
  material: TaskAttachmentCandidate,
  position: number
): TeamTaskAttachmentSummary {
  return {
    id: `draft:${material.id}`,
    taskId,
    materialId: material.id,
    name: material.name,
    category: material.category,
    availability: 'ready',
    previewState:
      material.previewState === 'unavailable'
        ? 'unavailable'
        : material.previewState === 'pending'
          ? 'pending'
          : 'ready',
    position
  };
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
  const [progressMaxInput, setProgressMaxInput] = useState(String(initialTask.progressMax));
  const [progressValue, setProgressValue] = useState(initialTask.progressValue);
  const [persistedAttachments, setPersistedAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<TeamTaskAttachmentSummary[]>([]);
  const [detachedMaterialIds, setDetachedMaterialIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);

  const hydrateTask = (next: TeamTaskSummary) => {
    setTask(next);
    setTitle(next.title);
    setNote(next.note ?? '');
    setStatus(next.status);
    setAssigneeId(next.assigneeId ?? '');
    setProgressMax(next.progressMax);
    setProgressMaxInput(String(next.progressMax));
    setProgressValue(next.progressValue);
  };

  const load = useCallback(
    async ({
      hydrate = false,
      resetAttachmentDraft = false
    }: { hydrate?: boolean; resetAttachmentDraft?: boolean } = {}) => {
      setLoading(true);
      try {
        const value = await client.getTask({ teamId, taskId: task.id, attachmentPageSize: 50 });
        if (hydrate) hydrateTask(value.task);
        else setTask(value.task);
        if (resetAttachmentDraft) {
          setPersistedAttachments(value.attachments);
          setDraftAttachments([]);
          setDetachedMaterialIds(new Set());
        } else {
          setPersistedAttachments(current => uniqueAttachments(current, value.attachments));
        }
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
    void load({ hydrate: true, resetAttachmentDraft: true });
  }, [load]);

  const visibleAttachments = useMemo(
    () => [
      ...persistedAttachments.filter(attachment => !detachedMaterialIds.has(attachment.materialId)),
      ...draftAttachments
    ],
    [detachedMaterialIds, draftAttachments, persistedAttachments]
  );
  const visibleMaterialIds = useMemo(
    () => new Set(visibleAttachments.map(attachment => attachment.materialId)),
    [visibleAttachments]
  );
  const attachmentCount = Math.max(
    0,
    task.attachmentCount - detachedMaterialIds.size + draftAttachments.length
  );
  const formDirty =
    title !== task.title ||
    note !== (task.note ?? '') ||
    assigneeId !== (task.assigneeId ?? '') ||
    progressMax !== task.progressMax ||
    progressValue !== task.progressValue;
  const attachmentDirty = draftAttachments.length > 0 || detachedMaterialIds.size > 0;
  // Status has an immediate server write and therefore intentionally does not make this dirty.
  const hasUnsavedChanges = canEdit && (formDirty || attachmentDirty);

  const loadMore = async () => {
    const cursor = persistedAttachments.at(-1)?.position;
    if (cursor === undefined) return;
    setLoadingMore(true);
    try {
      const value = await client.getTask({
        teamId,
        taskId: task.id,
        attachmentCursor: cursor,
        attachmentPageSize: 50
      });
      setPersistedAttachments(current => uniqueAttachments(current, value.attachments));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const addAttachments = (materials: TaskAttachmentCandidate[]) => {
    const persistedIds = new Set(persistedAttachments.map(attachment => attachment.materialId));
    const reattachedIds = new Set(
      materials.filter(item => persistedIds.has(item.id)).map(item => item.id)
    );
    if (reattachedIds.size > 0) {
      setDetachedMaterialIds(current => {
        const next = new Set(current);
        for (const id of reattachedIds) next.delete(id);
        return next;
      });
    }
    setDraftAttachments(current => {
      const known = new Set([...persistedIds, ...current.map(attachment => attachment.materialId)]);
      const additions = materials.filter(material => !known.has(material.id));
      if (additions.length === 0) return current;
      const position = Math.max(
        -1,
        ...persistedAttachments.map(attachment => attachment.position),
        ...current.map(attachment => attachment.position)
      );
      return [
        ...current,
        ...additions.map((material, index) =>
          draftAttachment(task.id, material, position + index + 1)
        )
      ];
    });
  };

  const stageDetach = (attachment: TeamTaskAttachmentSummary) => {
    if (attachment.id.startsWith('draft:')) {
      setDraftAttachments(current =>
        current.filter(candidate => candidate.materialId !== attachment.materialId)
      );
      return;
    }
    setDetachedMaterialIds(current => new Set(current).add(attachment.materialId));
  };

  const updateProgressMax = (raw: string) => {
    setProgressMaxInput(raw);
    if (!/^\d+$/u.test(raw)) return;
    const normalized = Math.min(TASK_PROGRESS_MAX, Math.max(1, Number(raw)));
    setProgressMax(normalized);
    setProgressValue(current => Math.min(current, normalized));
    if (String(normalized) !== raw) setProgressMaxInput(String(normalized));
  };

  const save = async () => {
    if (!canEdit || saving || savingStatus) return;
    setSaving(true);
    setError(false);
    try {
      let updated = task;
      if (formDirty) {
        const response = await client.updateTask(teamId, task.id, {
          title,
          note: note || null,
          assigneeId: assigneeId || null,
          progressMax,
          progressValue,
          expectedUpdatedAt: task.updatedAt
        });
        // The update RPC returns the physical row, while attachmentCount is
        // derived by the read RPC. Keep the known count while this editor stays open.
        updated = { ...response, attachmentCount: task.attachmentCount };
        setTask(updated);
      }
      if (draftAttachments.length > 0) {
        const result = await attachTaskMaterialsInChunks({
          client,
          teamId,
          taskId: task.id,
          materialIds: draftAttachments.map(attachment => attachment.materialId)
        });
        if (result.rejected.length > 0) throw new Error('ATTACHMENT_REJECTED');
      }
      for (const materialId of detachedMaterialIds) {
        await client.detachTaskMaterial(teamId, task.id, materialId);
      }
      onChanged({ ...updated, attachmentCount });
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const saveFromSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  const saveStatus = async (next: TeamTaskSummary['status']) => {
    if (!canEdit || next === status || savingStatus || saving) return;
    const previousTask = task;
    const previousStatus = status;
    setStatus(next);
    setSavingStatus(true);
    setError(false);
    try {
      const response = await client.updateTask(teamId, task.id, {
        status: next,
        expectedUpdatedAt: previousTask.updatedAt
      });
      const updated = { ...response, attachmentCount: previousTask.attachmentCount };
      setTask(updated);
      // Preserve a locally edited scale; otherwise reflect automatic completion progress.
      setProgressMax(current =>
        current === previousTask.progressMax ? updated.progressMax : current
      );
      setProgressValue(current =>
        current === previousTask.progressValue ? updated.progressValue : current
      );
      onChanged({ ...updated, attachmentCount: task.attachmentCount });
    } catch {
      setStatus(previousStatus);
      setError(true);
    } finally {
      setSavingStatus(false);
    }
  };

  const requestClose = () => {
    if (hasUnsavedChanges) {
      setShowUnsavedPrompt(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Modal
        labelledBy="team-task-editor-title"
        onClose={requestClose}
        closeLabel={t('teamCancel')}
        initialFocus="#team-task-title"
        size="lg"
      >
        <div className="team-task-editor">
          <form className="team-dialog-form" onSubmit={saveFromSubmit}>
            <div>
              <p className="team-workspace-eyebrow">{t('teamTasksEyebrow')}</p>
              <h2 id="team-task-editor-title">{t('teamTaskEditTitle')}</h2>
            </div>
            <section className="team-task-editor-status" aria-labelledby="team-task-status-title">
              <span id="team-task-status-title">{t('teamTaskStatus')}</span>
              <TaskStatusControl
                value={status}
                disabled={!canEdit || saving || savingStatus}
                onChange={next => void saveStatus(next)}
              />
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
            <div className="team-task-editor-meta">
              <label className="team-task-assignee-field">
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
              <label className="team-task-progress-max-field">
                <span>{t('teamTaskProgressMax')}</span>
                <input
                  inputMode="numeric"
                  type="number"
                  min={1}
                  max={TASK_PROGRESS_MAX}
                  value={progressMaxInput}
                  disabled={!canEdit}
                  onChange={event => updateProgressMax(event.target.value)}
                  onBlur={() => {
                    if (!/^\d+$/u.test(progressMaxInput)) setProgressMaxInput(String(progressMax));
                  }}
                />
              </label>
            </div>
            <TaskProgressScale
              value={progressValue}
              max={progressMax}
              disabled={!canEdit}
              label={t('teamTaskProgressScale')}
              onChange={setProgressValue}
            />
            <label>
              <span>{t('teamTaskDescription')}</span>
              <textarea
                className="team-task-description-input"
                rows={12}
                value={note}
                maxLength={2_000}
                disabled={!canEdit}
                onChange={event => setNote(event.target.value)}
              />
            </label>
            {error && <p className="team-inline-error">{t('teamTaskSaveFailed')}</p>}
            {canEdit && (
              <div className="team-dialog-actions">
                <Button type="submit" variant="primary" loading={saving} disabled={savingStatus}>
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
              <span>{t('teamTaskAttachmentsCount', { count: attachmentCount })}</span>
            </div>
            {loading && <p aria-live="polite">{t('teamTaskLoading')}</p>}
            <div className="team-task-attachment-grid">
              {visibleAttachments.map(attachment => (
                <TaskAttachmentTile
                  key={attachment.id}
                  teamId={teamId}
                  attachment={attachment}
                  client={client}
                  isDraft={attachment.id.startsWith('draft:')}
                  onDetach={canEdit ? () => stageDetach(attachment) : undefined}
                />
              ))}
              {canEdit && (
                <TaskAttachmentPicker
                  teamId={teamId}
                  client={client}
                  attachedMaterialIds={visibleMaterialIds}
                  onAdd={addAttachments}
                />
              )}
            </div>
            {persistedAttachments.length < task.attachmentCount && (
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
        </div>
      </Modal>
      {showUnsavedPrompt && (
        <Modal
          nested
          labelledBy="team-task-unsaved-title"
          onClose={() => setShowUnsavedPrompt(false)}
          closeLabel={t('teamCancel')}
          size="sm"
        >
          <div className="team-task-unsaved-confirmation">
            <h2 id="team-task-unsaved-title">{t('teamTaskUnsavedTitle')}</h2>
            <p>{t('teamTaskUnsavedDescription')}</p>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('teamTaskCloseWithoutSaving')}
              </Button>
              <Button type="button" variant="primary" loading={saving} onClick={() => void save()}>
                {t('teamTaskSave')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
