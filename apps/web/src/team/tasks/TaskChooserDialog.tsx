import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { ListTodo, Plus } from 'lucide-react';
import { PickerDialog, type PickerItem } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { taskStatusLabel } from './TaskStatusControl';

const CREATE = 'create-task'; // task ids are UUIDs, so this cannot collide

/**
 * «Which task?» — files into a task (024) and launches into a task (076).
 *
 * The task being worked on is the one most likely wanted, so the most recently
 * changed come first; typing narrows by name, and a name no task has becomes
 * «+ Create task "…"» at the top. A press chooses at once (075 `commit`).
 */
export function TaskChooserDialog({
  teamId,
  heading,
  listTasks,
  onChoose,
  onCreate,
  onClose
}: {
  teamId: string;
  heading: ReactNode;
  listTasks: (input: { teamId: string; pageSize?: number }) => Promise<TeamTaskSummary[]>;
  /** Resolves when the work is done; the dialog stays busy meanwhile. */
  onChoose: (task: TeamTaskSummary) => Promise<void>;
  onCreate?: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TeamTaskSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // The server's page is at most 100 (list_team_tasks); the recent ones come first.
    void listTasks({ teamId, pageSize: 100 })
      .then(found => {
        if (live) setTasks(found);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [listTasks, teamId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(tasks ?? [])]
      .filter(task => !needle || task.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
  }, [query, tasks]);

  const newTitle = query.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 160);
  const canCreate =
    Boolean(onCreate) &&
    tasks !== null &&
    newTitle.length > 0 &&
    !tasks.some(task => task.title.toLocaleLowerCase() === newTitle.toLocaleLowerCase());

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

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

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
        if (item.id === CREATE) {
          if (onCreate) void run(() => onCreate(newTitle));
          return;
        }
        const task = byId.get(item.id);
        if (task) void run(() => onChoose(task));
      }}
    />
  );
}
