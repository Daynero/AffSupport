import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { ListTodo, Plus } from 'lucide-react';
import { PickerDialog, type PickerItem } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute } from '../routes';
import { announceTaskAttachmentsChanged } from './taskAttachmentEvents';
import { taskStatusLabel } from './TaskStatusControl';

export interface AddToTaskClient {
  listTasks: (input: { teamId: string; pageSize?: number }) => Promise<TeamTaskSummary[]>;
  attachTaskMaterials: (input: {
    teamId: string;
    taskId: string;
    materialIds: string[];
  }) => Promise<{ attached: string[]; alreadyAttached: string[]; rejected: unknown[] }>;
  /** When given, a name no task has becomes a new task holding the files. */
  createTask?: (input: {
    teamId: string;
    title: string;
    note: null;
    initialMaterialId: string;
  }) => Promise<TeamTaskSummary>;
}

type Materials = { id: string; name: string }[];

const AddToTaskContext = createContext<((materials: Materials) => void) | null>(null);

/** Opens "Add to task…" for these materials, or null outside a space. */
export function useOptionalAddToTask(): ((materials: Materials) => void) | null {
  return useContext(AddToTaskContext);
}

/**
 * Handing a file to work that already exists (024, US11).
 *
 * A lead in Files could make a *new* task from a file and nothing else: putting
 * a file on a task that was already there meant going to Tasks, opening the
 * task, and finding the file again through the picker. Here the file stays
 * where it is, the task is found by typing its name, and nothing changes
 * section — the toast is the way to the task, for whoever wants to go.
 */
export function AddToTaskProvider({
  teamId,
  client = teamApi,
  children
}: {
  teamId: string;
  client?: AddToTaskClient;
  children: ReactNode;
}) {
  const [materials, setMaterials] = useState<Materials | null>(null);
  const open = useCallback((next: Materials) => {
    if (next.length > 0) setMaterials(next);
  }, []);
  return (
    <AddToTaskContext.Provider value={open}>
      {children}
      {materials && (
        <AddToTaskDialog
          teamId={teamId}
          client={client}
          materials={materials}
          onClose={() => setMaterials(null)}
        />
      )}
    </AddToTaskContext.Provider>
  );
}

export function AddToTaskDialog({
  teamId,
  client,
  materials,
  onClose
}: {
  teamId: string;
  client: AddToTaskClient;
  materials: Materials;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [tasks, setTasks] = useState<TeamTaskSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void client
      // The server's page is at most 100 (list_team_tasks); a picker looking for
      // the task being worked on needs the recent ones, which come first.
      .listTasks({ teamId, pageSize: 100 })
      .then(found => {
        if (live) setTasks(found);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client, teamId]);

  // The task being worked on is the one most likely wanted: most recent first.
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(tasks ?? [])]
      .filter(task => !needle || task.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
  }, [query, tasks]);

  // Typing a name no task has was a dead end ("No task has that name"): the file had to be
  // put down, a task made in Tasks, and the file found again. The name typed is the new task.
  const newTitle = query.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 160);
  const canCreate =
    Boolean(client.createTask) &&
    tasks !== null &&
    newTitle.length > 0 &&
    !(tasks ?? []).some(task => task.title.toLocaleLowerCase() === newTitle.toLocaleLowerCase());

  const add = async (task: TeamTaskSummary) => {
    setBusy(true);
    try {
      const result = await client.attachTaskMaterials({
        teamId,
        taskId: task.id,
        materialIds: materials.map(material => material.id)
      });
      announceTaskAttachmentsChanged(task.id);
      onClose();
      const href = buildTeamRoute({
        spaceId: teamId,
        section: 'tasks',
        query: { taskId: task.id }
      });
      push({
        tone: result.attached.length > 0 ? 'success' : 'info',
        text:
          result.attached.length > 0
            ? t('teamAddToTaskDone', { count: result.attached.length, task: task.title })
            : // Already there is information, not failure (FR-084).
              t('teamAddToTaskAlready', { task: task.title }),
        action: { label: t('teamAddToTaskOpen'), run: () => navigateTo(href) }
      });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const [first, ...rest] = materials;
    if (!client.createTask || !first) return;
    setBusy(true);
    try {
      const created = await client.createTask({
        teamId,
        title: newTitle,
        note: null,
        initialMaterialId: first.id
      });
      if (rest.length > 0) {
        await client.attachTaskMaterials({
          teamId,
          taskId: created.id,
          materialIds: rest.map(material => material.id)
        });
      }
      announceTaskAttachmentsChanged(created.id);
      onClose();
      const href = buildTeamRoute({
        spaceId: teamId,
        section: 'tasks',
        query: { taskId: created.id }
      });
      push({
        tone: 'success',
        text: t('teamAddToTaskCreated', { count: materials.length, task: created.title }),
        action: { label: t('teamAddToTaskOpen'), run: () => navigateTo(href) }
      });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setBusy(false);
    }
  };

  const heading =
    materials.length === 1
      ? t('teamAddToTaskTitleOne', { name: materials[0]!.name })
      : t('teamAddToTaskTitleMany', { count: materials.length });

  const CREATE = 'create-task'; // task ids are UUIDs, so this cannot collide
  const items: PickerItem[] = [
    ...(canCreate
      ? [
          {
            id: CREATE,
            title: t('teamAddToTaskCreate', { task: newTitle }),
            icon: <Plus size={16} strokeWidth={ICON_STROKE} />,
            action: true
          }
        ]
      : []),
    ...shown.map(task => ({
      id: task.id,
      title: task.title,
      subtitle: taskStatusLabel(task.status, t),
      icon: <ListTodo size={16} strokeWidth={ICON_STROKE} />
    }))
  ];
  const byId = new Map(shown.map(task => [task.id, task]));

  // 075: the same window as every other choice; a press chooses the task at once.
  return (
    <PickerDialog
      title={heading}
      onClose={onClose}
      closeLabel={t('teamCancel')}
      nested={false}
      mode="commit"
      busy={busy}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: t('teamAddToTaskSearch'),
        clearLabel: t('teamSearchClear')
      }}
      items={items}
      loading={tasks === null && !failed}
      loadingLabel={t('teamAddToTaskLoading')}
      error={failed ? t('teamAddToTaskLoadFailed') : null}
      empty={{ title: t(query.trim() ? 'teamAddToTaskNoMatch' : 'teamAddToTaskNone') }}
      onPick={item => {
        if (busy) return;
        if (item.id === CREATE) void create();
        else {
          const task = byId.get(item.id);
          if (task) void add(task);
        }
      }}
    />
  );
}
