import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FileText,
  FolderSync,
  ListChecks,
  type LucideIcon,
  Rocket,
  UserRound,
  X
} from 'lucide-react';
import type { TeamTaskStatus } from '@video-compressor/shared';
import type { TeamAuditEventSummary } from '../../api/team';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  IconButton,
  SegmentedControl
} from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { useAuth } from '../../auth/AuthContext';
import { useI18n, type TranslationKey } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { ACTION_LABEL, type TeamAuditClient } from '../members/TeamAuditPanel';
import { buildTeamRoute } from '../routes';
import { taskStatusLabel } from '../tasks/TaskStatusControl';

/**
 * What happened in the space, readable (024).
 *
 * It was a settings tab: every event a bold title, the file, the actor, a green "Succeeded" and
 * the date on a line of its own — ninety pixels a row, the same weight for everything, fifty
 * rows and no more. Now it is a panel from the space's menu: days as headings, one line per
 * event (what happened · to what · who · when), a badge only when something went wrong, repeats
 * folded into one line, a task opens from its line, and "Show earlier" pages back.
 */

type Area = 'all' | 'tasks' | 'files' | 'accounts' | 'people';
const PAGE = 50;
/** The same person doing the same thing to the same object within this is one line. */
const FOLD_MS = 10 * 60 * 1000;

function areaOf(action: string): Exclude<Area, 'all'> | 'storage' {
  if (action.startsWith('task.')) return 'tasks';
  if (action.startsWith('catalog.')) return 'files';
  if (action.startsWith('agent.')) return 'accounts';
  if (action.startsWith('material.') || action.startsWith('operation.')) return 'files';
  if (action.startsWith('membership.') || action.startsWith('invitation.')) return 'people';
  return 'storage';
}

const AREA_ICON: Record<ReturnType<typeof areaOf>, LucideIcon> = {
  tasks: ListChecks,
  accounts: Rocket,
  files: FileText,
  people: UserRound,
  storage: FolderSync
};

const WORK_LABEL: Record<string, TranslationKey> = {
  'task.created': 'historyTaskCreated',
  'task.status_changed': 'historyTaskStatus',
  'task.assigned': 'historyTaskAssigned',
  'task.file_attached': 'historyTaskFileAttached',
  'task.agent_tagged': 'historyTaskAgentTagged',
  'catalog.updated': 'historyCatalogUpdated',
  'agent.run_added': 'historyRunAdded',
  'agent.run_removed': 'historyRunRemoved'
};

const isCatalog = (name: string | null) => Boolean(name && /_v\d+_catalog$/iu.test(name));

interface Line {
  event: TeamAuditEventSummary;
  count: number;
}

function fold(events: readonly TeamAuditEventSummary[]): Line[] {
  const lines: Line[] = [];
  for (const event of events) {
    const last = lines.at(-1);
    if (
      last &&
      last.event.action === event.action &&
      last.event.actorLabel === event.actorLabel &&
      last.event.subjectLabel === event.subjectLabel &&
      last.event.result === event.result &&
      Date.parse(last.event.occurredAt) - Date.parse(event.occurredAt) < FOLD_MS
    ) {
      last.count += 1;
      continue;
    }
    lines.push({ event, count: 1 });
  }
  return lines;
}

export function HistoryDialog({
  teamId,
  client,
  onClose
}: {
  teamId: string;
  client: TeamAuditClient;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const [events, setEvents] = useState<TeamAuditEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [area, setArea] = useState<Area>('all');
  const [mine, setMine] = useState(false);

  const load = async (before?: string) => {
    setLoading(true);
    setError(false);
    try {
      const page = await client.listAuditEvents(teamId, { limit: PAGE, before });
      setEvents(current => (before ? [...current, ...page] : page));
      setMore(page.length === PAGE);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const shown = useMemo(
    () =>
      events.filter(
        event =>
          (area === 'all' || areaOf(event.action) === area) &&
          (!mine || (user?.id && event.actorId === user.id))
      ),
    [area, events, mine, user?.id]
  );

  const days = useMemo(() => {
    const groups = new Map<string, TeamAuditEventSummary[]>();
    for (const event of shown) {
      const key = new Date(event.occurredAt).toDateString();
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([key, dayEvents]) => ({ key, lines: fold(dayEvents) }));
  }, [shown]);

  const dayTitle = (key: string) => {
    const day = new Date(key);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (day.toDateString() === today.toDateString()) return t('historyToday');
    if (day.toDateString() === yesterday.toDateString()) return t('historyYesterday');
    return new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    }).format(day);
  };

  const what = (event: TeamAuditEventSummary) => {
    const target = event.target;
    if (event.action === 'task.status_changed' && target.to) {
      return t('historyTaskStatus', {
        status: taskStatusLabel(target.to as TeamTaskStatus, t)
      });
    }
    if (event.action === 'task.assigned') {
      return target.to ? t('historyTaskAssigned', { name: target.to }) : t('historyTaskUnassigned');
    }
    if (event.action === 'agent.run_added' || event.action === 'agent.run_removed') {
      return t(WORK_LABEL[event.action]!, { agent: target.agent ?? '' });
    }
    if (
      (event.action === 'material.upload' || event.action === 'material.uploaded') &&
      isCatalog(event.subjectLabel)
    ) {
      return t('historyCatalogCreated');
    }
    const key = WORK_LABEL[event.action] ?? ACTION_LABEL[event.action];
    return key ? t(key) : event.action;
  };

  /** The object, as a way to it when there is one. */
  const subject = (event: TeamAuditEventSummary) => {
    const target = event.target;
    const label = event.action.startsWith('agent.run')
      ? target.note
      : event.action === 'task.file_attached'
        ? event.subjectLabel
        : (event.subjectLabel ?? target.task_title);
    if (!label) return null;
    const taskId = target.task_id;
    if (taskId) {
      const href = buildTeamRoute({ spaceId: teamId, section: 'tasks', query: { taskId } });
      return (
        <a
          className="history-subject"
          href={href}
          title={label}
          onClick={event => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            onClose();
            navigateTo(href);
          }}
        >
          {label}
        </a>
      );
    }
    return (
      <span className="history-subject" title={label}>
        {label}
      </span>
    );
  };

  const time = (iso: string) =>
    new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));

  return (
    <Drawer side="right" size="lg" title={t('teamAuditTitle')} onClose={onClose}>
      <div className="history">
        <div className="history-filters">
          <SegmentedControl<Area>
            label={t('historyAreaLabel')}
            value={area}
            onChange={setArea}
            options={[
              { value: 'all', label: t('historyAreaAll') },
              { value: 'tasks', label: t('historyAreaTasks') },
              { value: 'files', label: t('historyAreaFiles') },
              { value: 'accounts', label: t('historyAreaAccounts') },
              { value: 'people', label: t('historyAreaPeople') }
            ]}
          />
          <Button
            type="button"
            className="history-mine"
            variant={mine ? 'secondary' : 'ghost'}
            aria-pressed={mine}
            onClick={() => setMine(current => !current)}
          >
            {mine ? (
              <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <UserRound size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
            {t('historyMine')}
          </Button>
          <IconButton
            className="history-close"
            variant="ghost"
            label={t('teamClose')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
        {error && <p className="team-inline-error">{t('teamAuditLoadFailed')}</p>}
        {loading && events.length === 0 && <LabeledSkeleton label="teamAuditLoading" rows={5} />}
        {!loading && !error && shown.length === 0 && (
          <EmptyState size="sm" title={t('teamAuditEmpty')} />
        )}
        {days.map(day => (
          <section key={day.key} className="history-day" aria-label={dayTitle(day.key)}>
            <h3>{dayTitle(day.key)}</h3>
            <ol>
              {day.lines.map(({ event, count }) => {
                const Icon = AREA_ICON[areaOf(event.action)];
                return (
                  <li key={event.id} className="history-line">
                    <Icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    <span className="history-what">{what(event)}</span>
                    {subject(event)}
                    {count > 1 && <span className="history-count">×{count}</span>}
                    {event.result !== 'succeeded' && (
                      <Badge
                        size="sm"
                        color={
                          event.result === 'denied'
                            ? 'warning'
                            : event.result === 'canceled'
                              ? 'neutral'
                              : 'error'
                        }
                      >
                        {t(
                          event.result === 'denied'
                            ? 'teamAuditDenied'
                            : event.result === 'canceled'
                              ? 'teamAuditCanceled'
                              : 'teamAuditFailed'
                        )}
                      </Badge>
                    )}
                    <span className="history-actor">
                      {event.actorLabel ?? t('teamFormerMember')}
                    </span>
                    <time dateTime={event.occurredAt}>{time(event.occurredAt)}</time>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
        {more && (
          <Button
            type="button"
            variant="ghost"
            loading={loading}
            onClick={() => void load(events.at(-1)?.occurredAt)}
          >
            {t('historyShowEarlier')}
          </Button>
        )}
      </div>
    </Drawer>
  );
}
