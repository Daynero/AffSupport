import { useCallback, useEffect, useState } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { Button } from '../../components/ui';
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
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [creatingAssetId, setCreatingAssetId] = useState<string | null>(null);
  /**
   * A task created by the "Create task" button and not yet given anything of
   * its own. There is no separate form any more: the button makes the real
   * task and opens it, so the one window a person sees is the task itself. The
   * marker is what keeps the old promise that walking away leaves nothing
   * behind (FR-026) — an untouched draft is removed when its editor closes.
   */
  const [draft, setDraft] = useState<{ id: string; touched: boolean } | null>(null);

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

  /** True when a filter is what is hiding the tasks, rather than there being none. */
  const filtered = tasks.statusFilter !== 'all' || tasks.filter.kind !== 'all';

  /**
   * Makes the task and opens it. The intermediate "name it first" dialog asked
   * for two of the fields the editor already has, on the way to the editor.
   */
  const startTask = useCallback(
    async (input: { title?: string; materialIds?: string[]; touched?: boolean } = {}) => {
      setBusy(true);
      setError(false);
      try {
        const materialIds = input.materialIds ?? [];
        const [firstId, ...restIds] = materialIds;
        const created = await tasks.create({
          title: input.title ?? t('teamTaskUntitled'),
          note: null,
          initialMaterialId: firstId ?? null
        });
        if (restIds.length > 0) {
          await attachTaskMaterialsInChunks({
            client,
            teamId,
            taskId: created.id,
            materialIds: restIds
          });
          await tasks.refetch();
        }
        setDraft({ id: created.id, touched: input.touched === true });
        setOpenTask(created);
      } catch {
        setError(true);
      } finally {
        setBusy(false);
      }
    },
    [client, setOpenTask, t, tasks, teamId]
  );

  /**
   * Closing the editor. A draft nobody gave anything to is removed rather than
   * left in the list as an empty row somebody has to tidy up later.
   */
  const closeEditor = useCallback(
    async (task: TeamTaskSummary) => {
      setOpenTask(null);
      if (!draft || draft.id !== task.id || draft.touched) {
        setDraft(null);
        return;
      }
      setDraft(null);
      try {
        await client.deleteTask({ teamId, taskId: task.id });
        await tasks.refetch();
      } catch {
        // Leaving the empty draft visible is better than a message about a
        // task the person never meant to make.
        await tasks.refetch();
      }
    },
    [client, draft, setOpenTask, tasks, teamId]
  );

  /**
   * A selection sent here from Files, Creatives or a landing: the task is made
   * with the asset's name and its materials already attached, then opened.
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
    void startTask({
      title: t('teamTaskFromAssetTitle', { name: createFromAsset.name }).slice(0, 160),
      materialIds,
      touched: true
    });
    onConsumedCreateFromAsset?.();
  }, [can, createFromAsset, creatingAssetId, onConsumedCreateFromAsset, startTask, t]);

  return (
    <section className="team-panel team-task-space" aria-labelledby="team-tasks-title">
      <div className="team-panel-heading team-task-space-heading">
        <div>
          <p className="team-workspace-eyebrow">{t('teamTasksEyebrow')}</p>
          <h2 id="team-tasks-title">{t('teamTasksTitle')}</h2>
        </div>
        {can('edit') && (
          <Button type="button" variant="primary" loading={busy} onClick={() => void startTask()}>
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
        <p aria-live="polite">{t('teamTasksLoadingList')}</p>
      )}
      {tasks.error && <p className="team-inline-error">{t('teamTasksLoadFailed')}</p>}
      {/* Three distinguishable answers, not one: still loading, nothing here
          at all, or nothing matching the filter in force (FR-020). */}
      {!tasks.loading && !tasks.error && tasks.tasks.length === 0 && (
        <div className="team-empty-state">
          {filtered ? (
            <p>{t('teamTasksEmptyFiltered')}</p>
          ) : (
            <>
              <p>{t('teamTasksEmpty')}</p>
              {can('edit') && (
                <Button
                  type="button"
                  variant="primary"
                  loading={busy}
                  onClick={() => void startTask()}
                >
                  {t('teamTasksEmptyAction')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
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

      {openTask && (
        <TaskEditor
          teamId={teamId}
          task={openTask}
          members={members}
          canEdit={can('edit')}
          client={client}
          onClose={() => void closeEditor(openTask)}
          onChanged={() => {
            setDraft(current => (current ? { ...current, touched: true } : null));
            void tasks.refetch();
          }}
          onDelete={
            can('edit')
              ? async task => {
                  try {
                    await client.deleteTask({ teamId, taskId: task.id });
                    setDraft(null);
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
