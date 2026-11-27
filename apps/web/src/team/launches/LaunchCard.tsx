import {
  launchCardState,
  launchCardLabels,
  launchCardProgress,
  type LaunchCardState
} from './launchPresentation.js';
import { formatTaskDate } from '../tasks/TaskDateField';
import { useRef, useState } from 'react';
import {
  Check,
  CircleDashed,
  Clock3,
  AlertCircle,
  Square,
  Link2,
  ListPlus,
  ListTodo,
  MoreHorizontal,
  Trash2
} from 'lucide-react';
import type { TeamLaunchTaskLink } from '../../api/team';
import { teamTaskDate, type LaunchSummary } from '@video-compressor/shared';
import {
  Button,
  Card,
  Badge,
  Checkbox,
  DropdownMenu,
  IconButton,
  Progress
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { campaignCountLabel } from './campaignCountLabel';
export function LaunchCard({
  value,
  onOpen,
  onCopyLink,
  onDelete,
  selected = false,
  onSelectedChange,
  queueState,
  actionsDisabled = false,
  tasks,
  onOpenTask,
  onAddToTask
}: {
  value: LaunchSummary;
  /** 076: the tasks this launch is in (a chip opens the first). */
  tasks?: readonly TeamLaunchTaskLink[];
  onOpenTask?: (taskId: string) => void;
  onAddToTask?: () => void;
  onOpen: () => void;
  onCopyLink?: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onSelectedChange?: (selected: boolean, modifiers?: { shiftKey: boolean }) => void;
  actionsDisabled?: boolean;
  queueState?: LaunchCardState;
}) {
  const { t, language } = useI18n();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const state = queueState ?? launchCardState(value);
  const color =
    state === 'ready'
      ? 'success'
      : state === 'failed'
        ? 'error'
        : state === 'partial'
          ? 'warning'
          : state === 'running' || state === 'queued'
            ? 'info'
            : 'neutral';
  const StateIcon =
    state === 'ready'
      ? Check
      : state === 'failed' || state === 'partial'
        ? AlertCircle
        : state === 'running' || state === 'queued'
          ? Clock3
          : state === 'canceled'
            ? Square
            : CircleDashed;
  // The card names the day the launch is for: the list filters by it, and a copy's
  // toast tells the user to look the copy up by it. When it was made goes in the title.
  const createdOn = value.createdAt
    ? teamTaskDate({ dateOn: null, createdAt: value.createdAt })
    : null;
  const shownOn = value.launchDate ?? createdOn;
  const ageLabel =
    value.gender === 'M'
      ? language === 'uk'
        ? 'Чоловіки'
        : 'Men'
      : value.gender === 'W'
        ? language === 'uk'
          ? 'Жінки'
          : 'Women'
        : value.gender === 'ALL'
          ? language === 'uk'
            ? 'Усі'
            : 'All'
          : null;
  const accountLabel = value.accountName?.trim() || value.social.trim();
  const agentSuffix = value.agentSuffix?.trim() || value.agentId?.trim().slice(-3);
  const accountChipLabel = agentSuffix
    ? [value.social.trim() || accountLabel, agentSuffix].filter(Boolean).join('-')
    : accountLabel;
  const assignment = value.assignment;
  const matchingCurrentAssignment =
    assignment?.state === 'assigned' &&
    assignment.agentRowId !== null &&
    assignment.agentRowId === assignment.sourceAgentRowId;
  /*
   * Busy or free, nothing in between (owner, beta 25.11): a launch held on the account — confirmed
   * or carried over from before assignments were recorded — makes it busy. "historical" is not an
   * occupancy but this launch's own story (it ran on an account it no longer holds); "neutral" is
   * only a page that has not been told yet, and says nothing rather than guess.
   */
  const accountStatus: 'free' | 'busy' | 'historical' | 'neutral' = assignment
    ? assignment.state === 'legacy_unknown' || matchingCurrentAssignment
      ? 'busy'
      : 'historical'
    : value.agentFree === true
      ? 'free'
      : value.agentFree === false
        ? 'busy'
        : 'neutral';
  const accountTooltip = [
    t('teamAgentTooltipAccount', { name: accountLabel }),
    t('teamAgentTooltipId', { id: value.agentId || value.agentSuffix || '' }),
    ...(matchingCurrentAssignment ? [t('launchesAssignmentCurrentAccount')] : []),
    ...(accountStatus === 'historical'
      ? [t('launchesAssignmentOriginalAccount')]
      : accountStatus === 'neutral'
        ? []
        : [t(accountStatus === 'busy' ? 'teamAgentBusy' : 'teamAgentFree')])
  ].join('\n');
  // 062: the first creative names the launch; the others show as a count — unless several
  // creatives were given a name of their own, which then names them here as everywhere.
  const others = (value.creativeCount ?? 1) - 1;
  const creativeLabel =
    others > 0 && value.creativeLabel
      ? value.creativeLabel
      : value.creativeAlias.trim()
        ? `${value.creativeAlias.trim()}${others > 0 ? ` +${others}` : ''}`
        : '';
  const methodLabel = [
    t(value.method === 'catalog' ? 'launchesCatalog' : 'launchesOther'),
    value.creativeKind === 'image' ? t('launchCreativeKindImage') : ''
  ]
    .filter(Boolean)
    .join(' · ');
  const heading =
    value.offer.trim() || creativeLabel || [accountLabel, methodLabel].filter(Boolean).join(' · ');
  return (
    <Card
      role="surface"
      interactive
      selected={selected}
      className="launch-card team-task-card"
      data-state={state}
      data-launch-id={value.id}
      onClick={event => {
        const target = event.target;
        // Keep selection and the menu independent, including portal menu events.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest('button, a, input, label, [role="checkbox"], [role="menuitem"]')) return;
        if (window.getSelection()?.toString()) return;
        if ((event.metaKey || event.ctrlKey || event.shiftKey) && onSelectedChange) {
          onSelectedChange(!selected, { shiftKey: event.shiftKey });
          return;
        }
        onOpen();
      }}
    >
      <div className="team-task-card-strip">
        {onSelectedChange && (
          <Checkbox
            className="team-task-card-select"
            checked={selected}
            aria-label={t('launchesSelectCard')}
            onChange={onSelectedChange}
          />
        )}
        <Button
          variant="ghost"
          className="launch-card-heading"
          title={heading}
          onClick={event => {
            if (window.getSelection()?.toString()) return;
            if ((event.metaKey || event.ctrlKey || event.shiftKey) && onSelectedChange)
              onSelectedChange(!selected, { shiftKey: event.shiftKey });
            else onOpen();
          }}
        >
          {heading}
        </Button>
        {accountChipLabel && (
          <span
            className={`team-task-agent-chip${accountStatus === 'free' ? ' is-free' : accountStatus === 'neutral' || accountStatus === 'historical' ? ' is-neutral' : ''}`}
            data-availability={accountStatus}
            title={accountTooltip}
          >
            <span className="team-task-agent-chip-dot" aria-hidden="true" />
            <span className="launch-card-account-label">{accountChipLabel}</span>
          </span>
        )}
        {(onCopyLink || onDelete || onAddToTask) && (
          <>
            <IconButton
              ref={menuAnchor}
              title=""
              size="xs"
              variant="ghost"
              color="neutral"
              className="team-task-card-menu"
              label={t('launchesCardActions')}
              onClick={() => setMenuOpen(current => !current)}
            >
              <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            <DropdownMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchor={menuAnchor}
              placement="start-top"
              label={t('launchesCardActions')}
              items={[
                ...(onAddToTask
                  ? [
                      {
                        id: 'task',
                        label: t('launchesToTask'),
                        icon: <ListPlus size={ICON_SIZE} />,
                        onSelect: onAddToTask
                      }
                    ]
                  : []),
                ...(onCopyLink
                  ? [
                      {
                        id: 'link',
                        label: t('launchesCopyLink'),
                        icon: <Link2 size={ICON_SIZE} />,
                        onSelect: onCopyLink
                      }
                    ]
                  : []),
                ...(onDelete
                  ? [
                      {
                        id: 'delete',
                        label: t('launchesArchive'),
                        icon: <Trash2 size={ICON_SIZE} />,
                        destructive: true,
                        disabled: actionsDisabled,
                        onSelect: onDelete
                      }
                    ]
                  : [])
              ]}
            />
          </>
        )}
      </div>
      <div className="launch-card-body">
        <span className="launch-card-content">
          <Badge color={color} className="launch-card-state">
            <StateIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(launchCardLabels[state])}
          </Badge>
          <span
            className="launch-card-context"
            title={[creativeLabel, methodLabel].filter(Boolean).join(' · ')}
          >
            {creativeLabel && creativeLabel !== heading && <strong>{creativeLabel} · </strong>}
            <span>{methodLabel}</span>
          </span>
          <span className="launch-card-facts">
            {value.campaignCount ? (
              <span>
                {value.campaignCount} {campaignCountLabel(language, value.campaignCount)}
              </span>
            ) : null}
            {ageLabel && value.age ? (
              <span>
                {ageLabel} {value.age}+
              </span>
            ) : null}
            {value.advantagePlus ? (
              <span>{language === 'uk' ? 'Advantage+' : 'Advantage+'}</span>
            ) : null}
          </span>
          {tasks && tasks.length > 0 && (
            <Button
              size="xs"
              variant="soft"
              color="neutral"
              className="launch-card-task"
              title={tasks.map(task => task.title).join('\n')}
              aria-label={t('launchesInTask', { task: tasks[0]!.title })}
              leading={<ListTodo size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              onClick={event => {
                event.stopPropagation();
                onOpenTask?.(tasks[0]!.taskId);
              }}
            >
              <span className="launch-card-task-title">{tasks[0]!.title}</span>
              {tasks.length > 1 && (
                <span className="launch-card-task-more">+{tasks.length - 1}</span>
              )}
            </Button>
          )}
        </span>
      </div>
      <div className="launch-card-progress">
        {(state === 'running' || state === 'queued' || state === 'partial') && (
          <Progress
            size="xs"
            color={color}
            label={t(launchCardLabels[state])}
            value={queueState ? undefined : launchCardProgress(value)}
          />
        )}
      </div>
      <div className="team-task-card-footer">
        {shownOn && (
          <>
            <time
              className="team-task-card-date"
              dateTime={shownOn}
              title={
                value.launchDate
                  ? t('launchesCardDateTitle', {
                      date: formatTaskDate(language, value.launchDate, true),
                      created: createdOn ? formatTaskDate(language, createdOn, true) : '—'
                    })
                  : t('teamTaskCreatedAt', { date: formatTaskDate(language, shownOn, true) })
              }
            >
              {formatTaskDate(language, shownOn)}
            </time>
            {value.createdAt && Number.isFinite(Date.parse(value.createdAt)) && (
              <span className="text-micro text-ink-muted">
                {t('launchesBulkCreated', {
                  date: new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                  }).format(new Date(value.createdAt))
                })}
              </span>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
