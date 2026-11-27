import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode
} from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { buildTeamRoute } from '../routes';
import { announceTaskAttachmentsChanged } from './taskAttachmentEvents';
import { TaskChooserDialog } from './TaskChooserDialog';

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
  const listTasks = useCallback(
    (input: { teamId: string; pageSize?: number }) => client.listTasks(input),
    [client]
  );

  const add = async (task: TeamTaskSummary) => {
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
    }
  };

  // Typing a name no task has was a dead end ("No task has that name"): the file had to be
  // put down, a task made in Tasks, and the file found again. The name typed is the new task.
  const create = async (title: string) => {
    const [first, ...rest] = materials;
    if (!client.createTask || !first) return;
    try {
      const created = await client.createTask({
        teamId,
        title,
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
    }
  };

  const heading =
    materials.length === 1
      ? t('teamAddToTaskTitleOne', { name: materials[0]!.name })
      : t('teamAddToTaskTitleMany', { count: materials.length });

  // 075: the same window as every other choice; a press chooses the task at once.
  return (
    <TaskChooserDialog
      teamId={teamId}
      heading={heading}
      listTasks={listTasks}
      onChoose={add}
      onCreate={client.createTask ? create : undefined}
      onClose={onClose}
    />
  );
}
