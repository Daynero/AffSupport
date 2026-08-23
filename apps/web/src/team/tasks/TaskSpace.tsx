import { useEffect, useState, type FormEvent } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { attachTaskMaterialsInChunks } from './TaskAttachmentPicker';
import { TaskCard } from './TaskCard';
import { TaskDateFilterControl } from './TaskDateFilter';
import { TaskEditor, type TaskEditorClient } from './TaskEditor';
import { useTasks, type TasksClient } from './useTasks';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';

export type TaskSpaceClient = TasksClient &
  TaskEditorClient & {
    listMembers(teamId: string): Promise<TeamMemberSummary[]>;
    deleteTask(input: { teamId: string; taskId: string }): Promise<true>;
  };

export interface TaskSourceAsset {
  /** One or more stable material ids to attach to the freshly created task. */
  ids?: string[];
  /** The legacy single-material shape remains valid for direct callers. */
  id?: string;
  /** Display label used to title the task (a single name, or an "N materials" summary). */
  name: string;
}

const defaultClient: TaskSpaceClient = teamApi;

function sourceMaterialIds(source: TaskSourceAsset | null): string[] {
  const candidateIds = source?.ids ?? (source?.id ? [source.id] : []);
  return [...new Set(candidateIds.filter(id => typeof id === 'string' && id.length > 0))];
}

export function TaskSpace({
  teamId,
  client = defaultClient,
  createFromAsset = null,
  onConsumedCreateFromAsset,
  openTaskId = null,
  onOpenTaskChange
}: {
  teamId: string;
  client?: TaskSpaceClient;
  createFromAsset?: TaskSourceAsset | null;
  onConsumedCreateFromAsset?: () => void;
  /** The task the address says is open, so a shared link lands on that task. */
  openTaskId?: string | null;
  /** Reports which task is open so the address can follow it. */
  onOpenTaskChange?: (taskId: string | null) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  const tasks = useTasks({ teamId, revision, client });
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [creatingAssetId, setCreatingAssetId] = useState<string | null>(null);
  /** Materials that will be attached when — and only when — the task is saved. */
  const [stagedMaterialIds, setStagedMaterialIds] = useState<string[]>([]);

  /**
   * Which task the editor is showing.
   *
   * Controlled by the address when the shell supplies `onOpenTaskChange` — that
   * is what makes `?task=` survive a refresh and lets Back close the editor
   * instead of leaving the section. Mounted on its own (a preview, a test) it
   * falls back to local state, so opening a task still works.
   */
  const [localOpenId, setLocalOpenId] = useState<string | null>(null);
  const controlled = Boolean(onOpenTaskChange);
  const effectiveOpenId = controlled ? openTaskId : localOpenId;
  const openTask = effectiveOpenId
    ? (tasks.tasks.find(task => task.id === effectiveOpenId) ?? null)
    : null;
  const setOpenTask = (task: TeamTaskSummary | null) => {
    if (controlled) onOpenTaskChange?.(task?.id ?? null);
    else setLocalOpenId(task?.id ?? null);
  };

  useEffect(() => {
    let active = true;
    void client
      .listMembers(teamId)
      .then(value => {
        if (active) setMembers(value);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, [client, revision, teamId]);

  /**
   * A selection sent here from Files, Creatives or a landing.
   *
   * It opens the create form with the title prefilled and the materials
   * *staged* — nothing is written yet. The old path called `create_team_task`
   * the moment the button was pressed, so abandoning the editor left a stray
   * empty task behind for someone to find later (finding R1, FR-026).
   */
  useEffect(() => {
    const materialIds = sourceMaterialIds(createFromAsset);
    const selectionKey = materialIds.join(',') || null;
    if (
      !createFromAsset ||
      materialIds.length === 0 ||
      !can('edit') ||
      creatingAssetId === selectionKey
    )
      return;
    setCreatingAssetId(selectionKey);
    setStagedMaterialIds(materialIds);
    setTitle(t('teamTaskFromAssetTitle', { name: createFromAsset.name }).slice(0, 160));
    setNote('');
    setCreating(true);
    onConsumedCreateFromAsset?.();
  }, [can, createFromAsset, creatingAssetId, onConsumedCreateFromAsset, t]);

  const cancelCreate = () => {
    setCreating(false);
    setTitle('');
    setNote('');
    setStagedMaterialIds([]);
    setCreatingAssetId(null);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const [firstId, ...restIds] = stagedMaterialIds;
      const created = await tasks.create({
        title,
        note: note || null,
        initialMaterialId: firstId ?? null
      });
      // The first material seeds the task; the rest attach in one follow-up
      // call, then the list is refetched so counts settle.
      if (restIds.length > 0) {
        await attachTaskMaterialsInChunks({
          client,
          teamId,
          taskId: created.id,
          materialIds: restIds
        });
        await tasks.refetch();
      }
      setCreating(false);
      setTitle('');
      setNote('');
      setStagedMaterialIds([]);
      setCreatingAssetId(null);
      setOpenTask(created);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-panel team-task-space" aria-labelledby="team-tasks-title">
      <div className="team-panel-heading team-task-space-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamTasksEyebrow')}</p>
          <h2 id="team-tasks-title">{t('teamTasksTitle')}</h2>
        </div>
        {can('edit') && (
          <Button type="button" variant="primary" loading={busy} onClick={() => setCreating(true)}>
            {t('teamTaskCreate')}
          </Button>
        )}
      </div>
      <TaskDateFilterControl
        value={tasks.filter}
        onChange={tasks.setFilter}
        status={tasks.statusFilter}
        onStatusChange={tasks.setStatusFilter}
      />
      {error && <p className="team-inline-error">{t('teamTaskCreateFailed')}</p>}
      {tasks.loading && tasks.tasks.length === 0 && (
        <p aria-live="polite">{t('teamTaskLoading')}</p>
      )}
      {tasks.error && <p className="team-inline-error">{t('teamTasksLoadFailed')}</p>}
      {!tasks.loading && !tasks.error && tasks.tasks.length === 0 && <p>{t('teamTasksEmpty')}</p>}
      <div className="team-task-grid">
        {tasks.tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            canEdit={can('edit')}
            onOpen={() => setOpenTask(task)}
            onUpdate={patch => tasks.update(task, patch)}
          />
        ))}
      </div>
      {tasks.hasMore && (
        <Button
          type="button"
          variant="secondary"
          loading={tasks.loadingMore}
          onClick={() => void tasks.loadMore()}
        >
          {t('teamTasksLoadMore')}
        </Button>
      )}

      {creating && (
        <Modal
          labelledBy="team-task-create-title"
          onClose={cancelCreate}
          // No `closeLabel`: the form already carries one Cancel, and a second
          // control with the same name is two ways to do one thing.
          initialFocus="#new-team-task-title"
          size="md"
        >
          <form className="team-dialog-form" onSubmit={event => void create(event)}>
            <h2 id="team-task-create-title">{t('teamTaskCreate')}</h2>
            {stagedMaterialIds.length > 0 && (
              <p className="team-task-staged-note">
                {t('teamTaskStagedAttachments', { count: stagedMaterialIds.length })}
              </p>
            )}
            <label>
              <span>{t('teamTaskTitle')}</span>
              <input
                id="new-team-task-title"
                value={title}
                maxLength={160}
                required
                onChange={event => setTitle(event.target.value)}
              />
            </label>
            <label>
              <span>{t('teamTaskDescription')}</span>
              <textarea
                className="team-task-description-input"
                value={note}
                maxLength={2_000}
                onChange={event => setNote(event.target.value)}
              />
            </label>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={cancelCreate}>
                {t('teamCancel')}
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {t('teamTaskCreate')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {openTask && (
        <TaskEditor
          teamId={teamId}
          task={openTask}
          members={members}
          canEdit={can('edit')}
          client={client}
          onClose={() => setOpenTask(null)}
          onChanged={() => {
            void tasks.refetch();
          }}
          onDelete={
            can('edit')
              ? async task => {
                  try {
                    await client.deleteTask({ teamId, taskId: task.id });
                    setOpenTask(null);
                    await tasks.refetch();
                    push({ tone: 'success', text: t('teamToastTaskDeleted') });
                  } catch (cause) {
                    push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
                  }
                }
              : undefined
          }
        />
      )}
    </section>
  );
}
