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
  MoreHorizontal,
  Trash2
} from 'lucide-react';
import { teamTaskDate, type LaunchSummary } from '@video-compressor/shared';
import {
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
  actionsDisabled = false
}: {
  value: LaunchSummary;
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
  const accountStatus: 'free' | 'busy' | 'unknown' | 'historical' = assignment
    ? assignment.state === 'legacy_unknown'
      ? 'unknown'
      : !matchingCurrentAssignment
        ? 'historical'
        : value.agentFree === false
          ? 'busy'
          : 'unknown' // A confirmed assignment and "free" contradict each other.
    : value.agentFree === true
      ? 'free'
      : value.agentFree === false
        ? 'busy'
        : 'unknown';
  const accountTooltip = [
    t('teamAgentTooltipAccount', { name: accountLabel }),
    t('teamAgentTooltipId', { id: value.agentId || value.agentSuffix || '' }),
    ...(matchingCurrentAssignment ? [t('launchesAssignmentCurrentAccount')] : []),
    accountStatus === 'historical'
      ? t('launchesAssignmentOriginalAccount')
      : assignment?.state === 'legacy_unknown'
        ? t('launchesAssignmentLegacy')
        : t(
            accountStatus === 'unknown'
              ? 'teamAgentAvailabilityUnknown'
              : accountStatus === 'busy'
                ? 'teamAgentBusy'
                : 'teamAgentFree'
          )
  ].join('\n');
  const methodLabel = t(value.method === 'catalog' ? 'launchesCatalog' : 'launchesOther');
  const heading =
    value.offer.trim() ||
    value.creativeAlias.trim() ||
    [accountLabel, methodLabel].filter(Boolean).join(' · ');
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
        <button
          type="button"
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
        </button>
        {accountChipLabel && (
          <span
            className={`team-task-agent-chip${accountStatus === 'free' ? ' is-free' : accountStatus === 'unknown' || accountStatus === 'historical' ? ' is-neutral' : ''}`}
            data-availability={accountStatus}
            title={accountTooltip}
          >
            <span className="team-task-agent-chip-dot" aria-hidden="true" />
            {accountChipLabel}
          </span>
        )}
        {(onCopyLink || onDelete) && (
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
          <Badge color={color}>
            <StateIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t(launchCardLabels[state])}
          </Badge>
          <span className="launch-card-context">
            {value.creativeAlias.trim() && value.creativeAlias.trim() !== heading && (
              <strong>{value.creativeAlias} · </strong>
            )}
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
        </span>
      </div>
      {(state === 'running' || state === 'queued' || state === 'partial') && (
        <Progress
          size="xs"
          color={color}
          label={t(launchCardLabels[state])}
          value={queueState ? undefined : launchCardProgress(value)}
        />
      )}
      {shownOn && (
        <div className="team-task-card-footer">
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
        </div>
      )}
    </Card>
  );
}
