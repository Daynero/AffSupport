import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { IconButton } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { teamErrorMessageFor } from '../errors';
import { TaskStatusIcon, taskStatusLabel } from '../tasks/TaskStatusControl';
import { HoverPeek } from '../workspace/HoverPeek';

export interface AgentTasksPeekClient {
  listTasks: typeof teamApi.listTasks;
  detachTaskAgent: typeof teamApi.detachTaskAgent;
}

const PEEK_LIMIT = 12;

/**
 * An agent's tasks, on its "N tasks" (the owner, 024).
 *
 * Freeing an agent from a task meant opening the board filtered to it, opening each task and
 * taking the chip off there. Resting on the count now shows the tasks as small tiles — status and
 * title — and each carries a × that takes this agent off that task, in place. A tile opens its
 * task.
 */
export function AgentTasksPeek({
  teamId,
  agentRowId,
  agentLabel,
  canEdit,
  trigger,
  onChanged,
  client = teamApi
}: {
  teamId: string;
  agentRowId: string;
  /** `v31-434`, for the × labels. */
  agentLabel: string;
  canEdit: boolean;
  trigger: ReactNode;
  onChanged?: () => void;
  client?: AgentTasksPeekClient;
}) {
  const { t } = useI18n();
  return (
    <HoverPeek trigger={trigger} label={t('teamAgentTasksPeek', { agent: agentLabel })}>
      {close => (
        <AgentTasksList
          teamId={teamId}
          agentRowId={agentRowId}
          agentLabel={agentLabel}
          canEdit={canEdit}
          client={client}
          onChanged={onChanged}
          onOpen={close}
        />
      )}
    </HoverPeek>
  );
}

function AgentTasksList({
  teamId,
  agentRowId,
  agentLabel,
  canEdit,
  client,
  onChanged,
  onOpen
}: {
  teamId: string;
  agentRowId: string;
  agentLabel: string;
  canEdit: boolean;
  client: AgentTasksPeekClient;
  onChanged?: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [tasks, setTasks] = useState<TeamTaskSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    void client
      .listTasks({ teamId, agentRowId, pageSize: PEEK_LIMIT })
      .then(found => {
        if (active) setTasks(found);
      })
      .catch(() => {
        if (active) setTasks([]);
      });
    return () => {
      active = false;
    };
  }, [agentRowId, client, teamId]);

  const detach = async (task: TeamTaskSummary) => {
    setTasks(current => current?.filter(item => item.id !== task.id) ?? null);
    try {
      await client.detachTaskAgent({ teamId, taskId: task.id, agentRowId });
      push({
        tone: 'success',
        text: t('teamAgentTaskDetached', { agent: agentLabel, task: task.title })
      });
      onChanged?.();
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      setTasks(current => (current ? [task, ...current] : [task]));
    }
  };

  // As tall as a row of tiles while it loads: the popover measures itself once, on open, and a
  // one-line "Loading…" left the tiles that followed in a 54px window.
  if (tasks === null) {
    return <p className="team-peek-empty is-loading">{t('teamPreviewLoading')}</p>;
  }
  if (tasks.length === 0) return <p className="team-peek-empty">{t('teamAgentTasksPeekNone')}</p>;

  return (
    <ul className="team-peek-grid">
      {tasks.map(task => {
        const href = buildTeamRoute({
          spaceId: teamId,
          section: 'tasks',
          query: { taskId: task.id }
        });
        return (
          <li key={task.id} className={`team-peek-tile is-${task.status}`}>
            <a
              href={href}
              className="team-peek-tile-open"
              title={task.title}
              onClick={event => {
                onOpen();
                internalLink(event, href);
              }}
            >
              {/* No hover tip: it covered the title it sits above. Said to a screen reader. */}
              <span className="team-peek-tile-status">
                <TaskStatusIcon status={task.status} />
                <span className="visually-hidden">{taskStatusLabel(task.status, t)}</span>
              </span>
              <span className="team-peek-tile-title">{task.title}</span>
            </a>
            {canEdit && (
              <IconButton
                size="xs"
                variant="ghost"
                className="team-peek-tile-remove"
                label={t('teamAgentTaskDetach', { agent: agentLabel, task: task.title })}
                onClick={() => void detach(task)}
              >
                <X aria-hidden="true" />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
