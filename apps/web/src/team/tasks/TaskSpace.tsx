import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, Eye, EyeOff } from 'lucide-react';
import type { TeamAccountSummary, TeamTaskSummary } from '@video-compressor/shared';
import { teamApi, type TeamMemberSummary } from '../../api/team';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { Empty, Input } from '../../components/ui/index';
import { useTeam } from '../TeamContext';
import { attachTaskMaterialsInChunks } from './TaskAttachmentPicker';
import { TaskCard } from './TaskCard';
import { TaskFilterBar } from './TaskFilterBar';
import { TaskEditor, type TaskEditorClient } from './TaskEditor';
import { useTasks, type TaskAccountScope, type TasksClient } from './useTasks';
import { persistedViewKey, usePersistedState } from '../persistedView';
import { useTaskLabels, type TaskLabelsClient } from '../labels/useTaskLabels';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  ErrorState,
  SelectionBar
} from '../../components/ui/index';
import { useTaskActions, type TaskActionHandlers } from './useTaskActions';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';

export type TaskSpaceClient = TasksClient &
  TaskEditorClient &
  TaskLabelsClient & {
    listMembers(teamId: string): Promise<TeamMemberSummary[]>;
    deleteTask(input: { teamId: string; taskId: string }): Promise<true>;
    listAccounts(teamId: string): Promise<TeamAccountSummary[]>;
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

function parseTaskAccountScope(value: unknown): TaskAccountScope | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'all') return { kind: 'all' };
  if (record.kind === 'account' && typeof record.accountId === 'string') {
    return { kind: 'account', accountId: record.accountId };
  }
  if (record.kind === 'agent' && typeof record.agentRowId === 'string') {
    return { kind: 'agent', agentRowId: record.agentRowId };
  }
  return null;
}

export function TaskSpace({
  teamId,
  client = defaultClient,
  createFromAsset = null,
  onConsumedCreateFromAsset,
  openTaskId = null,
  onOpenTaskChange,
  scope: scopeProp,
  onScopeChange
}: {
  teamId: string;
  client?: TaskSpaceClient;
  createFromAsset?: TaskSourceAsset | null;
  onConsumedCreateFromAsset?: () => void;
  /** The task the address says is open, so a shared link lands on that task. */
  openTaskId?: string | null;
  /** Reports which task is open so the address can follow it. */
  onOpenTaskChange?: (taskId: string | null) => void;
  /** Which account's or agent's tasks the address asks for (017). */
  scope?: TaskAccountScope;
  onScopeChange?: (scope: TaskAccountScope) => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { can, revision } = useTeam();
  /**
   * The account scope is the address's when the shell supplies it, so a link
   * from the Accounts tab lands narrowed and Back widens it again; mounted on
   * its own it is local state, like the open task.
   */
  const [localScope, setLocalScope] = usePersistedState<TaskAccountScope>(
    persistedViewKey(teamId, 'tasks.scope'),
    { kind: 'all' },
    parseTaskAccountScope
  );
  const scope = onScopeChange ? (scopeProp ?? { kind: 'all' }) : localScope;
  const setScope = onScopeChange ?? setLocalScope;
  const tasks = useTasks({ teamId, revision, scope, client });
  /**
   * The space's tag dictionary (018), read once here and handed to both the
   * filter and the editor: two copies would mean two realtime channels for a
   * list that changes a few times a month.
   */
  const labels = useTaskLabels({ teamId, revision, client });
  /**
   * Which cards have their brief unfolded. Held here rather than in each card
   * so one control can open the whole board — reading every brief in a
   * column is how a morning starts — and so the label can say which way the
   * next press goes.
   */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Which tasks a bulk action applies to (024, FR-075).
   *
   * Not persisted: a selection is about what you are doing right now, and a
   * board that came back from a reload with seven tasks still ticked would be
   * offering to delete them on somebody else's behalf.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Whether the cards show their progress scales. Some boards are run on the
   * scale and some never touch it, and for the second kind it is a bar of
   * colour under every title. One press puts it away, and the space remembers.
   *
   * Through `persistedView` like every other board preference (024): it had a
   * storage key, a reader, a writer and an effect of its own, which is four
   * pieces of the same mechanism written twice — and the two disagreed about
   * what happens when you switch spaces.
   */
  const [progressShown, setProgressShown] = usePersistedState<boolean>(
    persistedViewKey(teamId, 'tasks.progressShown'),
    true,
    value => (typeof value === 'boolean' ? value : null)
  );
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [accounts, setAccounts] = useState<TeamAccountSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [creatingAssetId, setCreatingAssetId] = useState<string | null>(null);
  /**
   * A task created by the "Create task" button and not yet given anything of
   * its own. There is no separate form any more: the button makes the real
   * task and opens it, so the one window a person sees is the task itself. The
   * marker is what keeps the old promise that walking away leaves nothing
   * behind (FR-026) — an untouched draft is removed when its editor closes.
   *
   * A ref, not state: saving reports the change and closes the editor in the
   * same tick, so a `closeEditor` holding a render-time copy of this would see
   * the draft as untouched and delete the task the person had just saved.
   */
  const draft = useRef<{ id: string; touched: boolean } | null>(null);

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
  /*
   * The open task is the one the person is working on, not a row of the board.
   * Set to "Done" under an "In progress" filter it leaves the board — and the
   * editor used to close under the person's hands, then spring open again the
   * moment "Done" was chosen, because the address still named it. It stays
   * open on the last copy the board held until it is closed.
   */
  const lastOpenTask = useRef<TeamTaskSummary | null>(null);
  const listedOpenTask = effectiveOpenId
    ? (tasks.allTasks.find(task => task.id === effectiveOpenId) ?? null)
    : null;
  if (listedOpenTask) lastOpenTask.current = listedOpenTask;
  const openTask =
    listedOpenTask ??
    (effectiveOpenId && lastOpenTask.current?.id === effectiveOpenId ? lastOpenTask.current : null);
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

  // The accounts feed the filter pill. Re-read when the space changes and when
  // this editor wrote a tag or a run — not on every task refetch, which would
  // be a second round trip per realtime tick for a list that rarely moves.
  const [accountsVersion, setAccountsVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void client
      .listAccounts(teamId)
      .then(value => {
        if (active) setAccounts(value);
      })
      .catch(() => {
        if (active) setAccounts([]);
      });
    return () => {
      active = false;
    };
  }, [accountsVersion, client, revision, teamId]);

  /** True when a filter is what is hiding the tasks, rather than there being none. */
  const filtered =
    tasks.statusFilter !== 'all' ||
    tasks.filter.kind !== 'all' ||
    scope.kind !== 'all' ||
    tasks.labelIds.length > 0 ||
    tasks.assignee.kind !== 'all';

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
        draft.current = { id: created.id, touched: input.touched === true };
        setOpenTask(created);
      } catch {
        setError(true);
      } finally {
        setBusy(false);
      }
    },
    [client, setOpenTask, t, tasks, teamId]
  );

  /** The board's quick-add: a title in, a task out, focus kept for the next. */
  const [quickTitle, setQuickTitle] = useState('');
  const quickAddInput = useRef<HTMLInputElement>(null);
  const quickAdd = useCallback(async () => {
    const title = quickTitle.trim();
    if (!title) return;
    setBusy(true);
    setError(false);
    try {
      await tasks.create({ title, note: null, initialMaterialId: null });
      setQuickTitle('');
      quickAddInput.current?.focus();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [quickTitle, tasks]);

  /**
   * Closing the editor. A draft nobody gave anything to is removed rather than
   * left in the list as an empty row somebody has to tidy up later.
   */
  const closeEditor = useCallback(
    async (task: TeamTaskSummary) => {
      setOpenTask(null);
      const pending = draft.current;
      draft.current = null;
      if (!pending || pending.id !== task.id || pending.touched) return;
      try {
        await client.deleteTask({ teamId, taskId: task.id });
        await tasks.refetch();
      } catch {
        // Leaving the empty draft visible is better than a message about a
        // task the person never meant to make.
        await tasks.refetch();
      }
    },
    [client, setOpenTask, tasks, teamId]
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
      title: createFromAsset.name.slice(0, 160),
      materialIds,
      touched: true
    });
    onConsumedCreateFromAsset?.();
  }, [can, createFromAsset, creatingAssetId, onConsumedCreateFromAsset, startTask, t]);

  const bulkAnchor = useRef<HTMLDivElement>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  /** The tasks a confirmed delete would take — one from a card, or the set. */
  const [confirmingDelete, setConfirmingDelete] = useState<readonly TeamTaskSummary[]>([]);
  const selected = useMemo(
    () => tasks.tasks.filter(task => selectedIds.has(task.id)),
    [selectedIds, tasks.tasks]
  );

  /**
   * The same actions a card offers, applied to the whole set (024, FR-075).
   *
   * Only what is safe in bulk: a status, an assignee, a tag, and a delete that
   * is takeable back. Nothing here needs a confirmation dialog, because the
   * one destructive thing among them reports what it did and offers the undo —
   * which is the rule the rest of the workspace already follows.
   */
  /** One task's menu, from the same list the bar uses. */
  const cardActions = useCallback(
    (task: TeamTaskSummary): TaskActionHandlers => ({
      patch: patch => void tasks.update(task, patch, { checkVersion: false }),
      tag: label => {
        if (task.labels.some(item => item.id === label.id)) return;
        void client
          .attachTaskLabel({ teamId, taskId: task.id, labelId: label.id })
          .then(next => tasks.setTaskLabels(task.id, next))
          .catch((cause: unknown) => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }));
      },
      // Asked the same way the bulk delete asks, for the same reason: a task
      // does not come back, so the question names what goes with it.
      remove: () => setConfirmingDelete([task])
    }),
    [client, push, t, tasks, teamId]
  );

  const bulk: TaskActionHandlers = useMemo(
    () => ({
      patch: patch => {
        void (async () => {
          try {
            for (const task of selected) await tasks.update(task, patch, { checkVersion: false });
            push({ tone: 'success', text: t('teamTaskBulkDone', { count: selected.length }) });
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          }
        })();
      },
      tag: label => {
        void (async () => {
          try {
            for (const task of selected) {
              if (task.labels.some(item => item.id === label.id)) continue;
              const next = await client.attachTaskLabel({
                teamId,
                taskId: task.id,
                labelId: label.id
              });
              tasks.setTaskLabels(task.id, next);
            }
            push({ tone: 'success', text: t('teamTaskBulkDone', { count: selected.length }) });
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          }
        })();
      },
      /**
       * Deleting asks first, and the question names the consequence.
       *
       * Not a toast with an Undo, which is what the rest of the workspace
       * offers: a trashed file can come back because the Drive keeps it, and a
       * deleted task cannot. Recreating one from what the board still holds
       * would give back a title and lose the attachments, the tags, the
       * accounts and the progress — an undo that quietly does something else
       * is worse than no undo (021, finding R3).
       */
      remove: () => setConfirmingDelete(selected)
    }),
    [client, push, selected, t, tasks, teamId]
  );

  const removeConfirmed = useCallback(async () => {
    const removed = [...confirmingDelete];
    try {
      for (const task of removed) await client.deleteTask({ teamId, taskId: task.id });
      setSelectedIds(current => {
        const ids = new Set(current);
        for (const task of removed) ids.delete(task.id);
        return ids;
      });
      await tasks.refetch();
      push({ tone: 'success', text: t('teamTaskBulkDeleted', { count: removed.length }) });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setConfirmingDelete([]);
    }
  }, [client, confirmingDelete, push, t, tasks, teamId]);

  const bulkItems = useTaskActions({
    tasks: selected,
    canEdit: can('edit'),
    members,
    labels: labels.labels,
    handlers: bulk
  });

  const allExpanded = tasks.tasks.length > 0 && expandedIds.size >= tasks.tasks.length;
  // Nothing on the board and nothing filtering it: the empty state speaks.
  const boardEmpty = !tasks.loading && !tasks.error && tasks.tasks.length === 0 && !filtered;
  const toggleAll = () =>
    setExpandedIds(allExpanded ? new Set() : new Set(tasks.tasks.map(task => task.id)));

  return (
    <section className="team-panel team-task-space" aria-labelledby="team-tasks-title">
      <div className="team-panel-heading team-task-space-heading">
        <h2 id="team-tasks-title">{t('teamTasksTitle')}</h2>
        {tasks.tasks.length > 0 && (
          <button type="button" className="team-task-expand-all" onClick={toggleAll}>
            <ChevronsUpDown size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(allExpanded ? 'teamTasksCollapseAll' : 'teamTasksExpandAll')}
          </button>
        )}
        {/* The eye, next to it and quieter: an icon alone, because the thing
            it hides is on screen to be seen or not — a word beside it would
            take more room than the scale it puts away. */}
        {tasks.tasks.length > 0 && (
          <button
            type="button"
            className={`team-task-progress-toggle${progressShown ? '' : ' is-off'}`}
            aria-pressed={!progressShown}
            title={t(progressShown ? 'teamTasksProgressHide' : 'teamTasksProgressShow')}
            aria-label={t(progressShown ? 'teamTasksProgressHide' : 'teamTasksProgressShow')}
            onClick={() => setProgressShown(current => !current)}
          >
            {progressShown ? (
              <Eye size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <EyeOff size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
          </button>
        )}
        {/* One way to make a task, and it is the fast one (024, FR-090): type
            what it is and press Enter, and it is on the board; the next one
            can be typed straight away. The button opens the editor for a task
            with more to say. Hidden while the empty state below carries the
            same invitation — two primaries for one act is one too many. */}
        {can('edit') && !boardEmpty && (
          <form
            className="team-task-quick-add"
            onSubmit={event => {
              event.preventDefault();
              void quickAdd();
            }}
          >
            <Input
              ref={quickAddInput}
              aria-label={t('teamTaskQuickAdd')}
              placeholder={t('teamTaskQuickAdd')}
              value={quickTitle}
              maxLength={160}
              onChange={event => setQuickTitle(event.target.value)}
            />
            <Button
              type={quickTitle.trim() ? 'submit' : 'button'}
              variant="primary"
              loading={busy}
              onClick={quickTitle.trim() ? undefined : () => void startTask()}
            >
              {/* One short word either way: with a name it adds, without one it
                  opens the editor to write the task out. */}
              {t('teamTaskQuickAddAction')}
            </Button>
          </form>
        )}
      </div>
      <TaskFilterBar
        query={tasks.query}
        onQueryChange={tasks.setQuery}
        date={tasks.filter}
        onDateChange={tasks.setFilter}
        status={tasks.statusFilter}
        onStatusChange={tasks.setStatusFilter}
        accounts={accounts}
        scope={scope}
        onScopeChange={setScope}
        members={members}
        assignee={tasks.assignee}
        onAssigneeChange={tasks.setAssignee}
        labels={labels.labels}
        labelIds={tasks.labelIds}
        onLabelIdsChange={tasks.setLabelIds}
        sort={tasks.sort}
        onSortChange={tasks.setSort}
      />
      {error && (
        <p className="team-inline-error" role="alert">
          {t('teamTaskCreateFailed')}
        </p>
      )}
      {/* The shape of the board that is coming, so the cards do not push the
          filters when they land — with the sentence still there, because a
          shimmer alone is indistinguishable from a stuck screen. */}
      {tasks.loading && tasks.tasks.length === 0 && (
        <LabeledSkeleton label="teamTasksLoadingList" rows={3} />
      )}
      {tasks.error && (
        <ErrorState className="team-inline-error" message={t('teamTasksLoadFailed')} />
      )}
      {/* Three distinguishable answers, not one: still loading, nothing here
          at all, or nothing matching the filter in force (FR-020). */}
      {!tasks.loading && !tasks.error && tasks.tasks.length === 0 && (
        <Empty
          title={t(filtered ? 'teamTasksEmptyFiltered' : 'teamTasksEmpty')}
          description={filtered ? undefined : t('teamTasksEmptyBody')}
          action={
            !filtered &&
            can('edit') && (
              <Button type="button" color="primary" loading={busy} onClick={() => void startTask()}>
                {t('teamTasksEmptyAction')}
              </Button>
            )
          }
        />
      )}
      <SelectionBar
        count={selected.length}
        label={t('teamTaskSelectedCount', { count: selected.length })}
        clearLabel={t('teamTaskClearSelection', { count: selected.length })}
        onClear={() => setSelectedIds(new Set())}
        actions={
          <div ref={bulkAnchor} className="team-task-bulk">
            <Button
              size="sm"
              color="neutral"
              variant="outline"
              onClick={() => setBulkOpen(current => !current)}
            >
              {t('teamTaskBulkActions')}
            </Button>
            <DropdownMenu
              open={bulkOpen}
              onClose={() => setBulkOpen(false)}
              anchor={bulkAnchor}
              placement="top-start"
              items={bulkItems}
              label={t('teamTaskBulkActions')}
            />
          </div>
        }
      />
      {confirmingDelete.length > 0 && (
        <ConfirmDialog
          title={t('teamTaskBulkDeleteTitle', { count: confirmingDelete.length })}
          body={t('teamTaskBulkDeleteBody', { count: confirmingDelete.length })}
          confirmLabel={t('teamTaskDelete')}
          cancelLabel={t('teamCancel')}
          onCancel={() => setConfirmingDelete([])}
          onConfirm={() => void removeConfirmed()}
        />
      )}
      <div className="team-task-grid">
        {tasks.tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            canEdit={can('edit')}
            showProgress={progressShown}
            expanded={expandedIds.has(task.id)}
            onExpandedChange={next =>
              setExpandedIds(current => {
                const ids = new Set(current);
                if (next) ids.add(task.id);
                else ids.delete(task.id);
                return ids;
              })
            }
            onOpen={() => setOpenTask(task)}
            onUpdate={patch => tasks.update(task, patch, { checkVersion: false })}
            members={members}
            labels={labels.labels}
            actions={can('edit') ? cardActions(task) : undefined}
            selected={can('edit') ? selectedIds.has(task.id) : undefined}
            onSelectedChange={
              can('edit')
                ? next =>
                    setSelectedIds(current => {
                      const ids = new Set(current);
                      if (next) ids.add(task.id);
                      else ids.delete(task.id);
                      return ids;
                    })
                : undefined
            }
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
          labels={labels.labels}
          onClose={() => void closeEditor(openTask)}
          onChanged={() => {
            if (draft.current) draft.current = { ...draft.current, touched: true };
            void tasks.refetch();
          }}
          onTagsChange={agents => {
            if (draft.current) draft.current = { ...draft.current, touched: true };
            tasks.setTaskAgents(openTask.id, agents);
            setAccountsVersion(version => version + 1);
          }}
          onLabelsChange={next => {
            if (draft.current) draft.current = { ...draft.current, touched: true };
            tasks.setTaskLabels(openTask.id, next);
            // The counts in settings follow the same tag write.
            void labels.refetch();
          }}
          onLabelCreated={() => void labels.refetch()}
          onDelete={
            can('edit')
              ? async task => {
                  try {
                    await client.deleteTask({ teamId, taskId: task.id });
                    draft.current = null;
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
