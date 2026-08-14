import { useEffect, useState, type FormEvent } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { TaskCard } from './TaskCard';
import { TaskDateFilterControl } from './TaskDateFilter';
import { TaskEditor, type TaskEditorClient } from './TaskEditor';
import { useTasks, type TasksClient } from './useTasks';

export type TaskSpaceClient = TasksClient &
  TaskEditorClient & {
    listMembers(teamId: string): Promise<TeamMemberSummary[]>;
  };

export interface TaskSourceAsset {
  id: string;
  name: string;
}

const defaultClient: TaskSpaceClient = teamApi;

export function TaskSpace({
  teamId,
  client = defaultClient,
  createFromAsset = null,
  onConsumedCreateFromAsset
}: {
  teamId: string;
  client?: TaskSpaceClient;
  createFromAsset?: TaskSourceAsset | null;
  onConsumedCreateFromAsset?: () => void;
}) {
  const { t } = useI18n();
  const { can, revision } = useTeam();
  const tasks = useTasks({ teamId, revision, client });
  const [openTask, setOpenTask] = useState<TeamTaskSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [creatingAssetId, setCreatingAssetId] = useState<string | null>(null);

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

  useEffect(() => {
    if (!createFromAsset || !can('edit') || creatingAssetId === createFromAsset.id) return;
    setCreatingAssetId(createFromAsset.id);
    setBusy(true);
    void tasks
      .create({
        title: t('teamTaskFromAssetTitle', { name: createFromAsset.name }).slice(0, 160),
        initialMaterialId: createFromAsset.id
      })
      .then(created => {
        setOpenTask(created);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => {
        setBusy(false);
        onConsumedCreateFromAsset?.();
      });
  }, [can, createFromAsset, creatingAssetId, onConsumedCreateFromAsset, t, tasks]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const created = await tasks.create({ title, note: note || null });
      setCreating(false);
      setTitle('');
      setNote('');
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
      <TaskDateFilterControl value={tasks.filter} onChange={tasks.setFilter} />
      {error && <p className="team-inline-error">{t('teamTaskCreateFailed')}</p>}
      {tasks.loading && tasks.tasks.length === 0 && (
        <p aria-live="polite">{t('teamTaskLoading')}</p>
      )}
      {tasks.error && <p className="team-inline-error">{t('teamTasksLoadFailed')}</p>}
      {!tasks.loading && !tasks.error && tasks.tasks.length === 0 && <p>{t('teamTasksEmpty')}</p>}
      <div className="team-task-grid">
        {tasks.tasks.map(task => (
          <TaskCard key={task.id} task={task} onOpen={() => setOpenTask(task)} />
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
          onClose={() => setCreating(false)}
          closeLabel={t('teamCancel')}
          initialFocus="#new-team-task-title"
          size="md"
        >
          <form className="team-dialog-form" onSubmit={event => void create(event)}>
            <h2 id="team-task-create-title">{t('teamTaskCreate')}</h2>
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
              <span>{t('teamTaskNote')}</span>
              <textarea
                value={note}
                maxLength={2_000}
                onChange={event => setNote(event.target.value)}
              />
            </label>
            <div className="team-dialog-actions">
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
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
          onChanged={updated => {
            setOpenTask(updated);
            void tasks.refetch();
          }}
        />
      )}
    </section>
  );
}
