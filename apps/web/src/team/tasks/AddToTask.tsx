import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { useToasts } from '../../components/toast';
import { Input } from '../../components/ui/index';
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
  const titleId = useId();
  const listId = useId();
  const [tasks, setTasks] = useState<TeamTaskSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLUListElement>(null);

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

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

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

  const heading =
    materials.length === 1
      ? t('teamAddToTaskTitleOne', { name: materials[0]!.name })
      : t('teamAddToTaskTitleMany', { count: materials.length });

  return (
    <Modal
      labelledBy={titleId}
      size="sm"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#team-add-to-task-search"
    >
      <div className="team-add-to-task">
        <h2 id={titleId}>{heading}</h2>
        <Input
          id="team-add-to-task-search"
          aria-label={t('teamAddToTaskSearch')}
          placeholder={t('teamAddToTaskSearch')}
          value={query}
          role="combobox"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive(index => Math.min(index + 1, Math.max(shown.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(index => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const task = shown[active];
              if (task && !busy) void add(task);
            }
          }}
        />
        {failed ? (
          <p className="team-inline-error" role="alert">
            {t('teamAddToTaskLoadFailed')}
          </p>
        ) : tasks === null ? (
          <p className="team-add-to-task-note">{t('teamAddToTaskLoading')}</p>
        ) : shown.length === 0 ? (
          <p className="team-add-to-task-note">
            {t(query.trim() ? 'teamAddToTaskNoMatch' : 'teamAddToTaskNone')}
          </p>
        ) : (
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={heading}
            className="team-add-to-task-list"
          >
            {shown.map((task, index) => (
              <li
                key={task.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  if (!busy) void add(task);
                }}
              >
                <span className="team-add-to-task-name">{task.title}</span>
                <span className="team-add-to-task-meta">{taskStatusLabel(task.status, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
