import { formatTaskDate } from '../tasks/TaskDateField';
import { useRef, useState } from 'react';
import { Link2, MoreHorizontal, Trash2 } from 'lucide-react';
import { teamTaskDate, type LaunchSummary } from '@video-compressor/shared';
import { Card, Button, Badge, Checkbox, DropdownMenu, IconButton } from '../../components/ui/index';
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
  actionsDisabled = false
}: {
  value: LaunchSummary;
  onOpen: () => void;
  onCopyLink?: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  actionsDisabled?: boolean;
}) {
  const { t, language } = useI18n();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const attention = ['failed', 'partial', 'interrupted'].includes(value.generationState ?? '');
  const generating =
    value.generationState !== null &&
    !['succeeded', 'canceled', 'failed', 'partial', 'interrupted'].includes(value.generationState);
  const createdOn = value.createdAt
    ? teamTaskDate({ dateOn: null, createdAt: value.createdAt })
    : null;
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
  const accountLabel = value.accountName || value.social;
  const accountTooltip = [
    `${t('teamAgentTooltipAccount', { name: accountLabel })}`,
    `${t('teamAgentTooltipId', { id: value.agentId || value.agentSuffix || '' })}`,
    t(value.agentFree === false ? 'teamAgentBusy' : 'teamAgentFree')
  ].join('\n');
  return (
    <Card
      role="surface"
      interactive
      selected={selected}
      className="launch-card team-task-card"
      data-launch-id={value.id}
      onClick={event => {
        const target = event.target;
        // Keep selection and the menu independent, including portal menu events.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest('button, a, input, label, [role="checkbox"], [role="menuitem"]')) return;
        if (window.getSelection()?.toString()) return;
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
        <span className="launch-card-heading" title={value.offer || t('launchesNew')}>
          {value.offer || t('launchesNew')}
        </span>
        {accountLabel && value.agentSuffix && (
          <span
            className={`team-task-agent-chip${value.agentFree === false ? '' : ' is-free'}`}
            title={accountTooltip}
          >
            <span className="team-task-agent-chip-dot" aria-hidden="true" />
            {value.social}-{value.agentSuffix}
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
              <MoreHorizontal size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
      <Button
        variant="ghost"
        className="launch-card-open w-full min-w-0 justify-start text-left"
        onClick={onOpen}
      >
        <span className="launch-card-content">
          {(attention || generating) && (
            <Badge color={attention ? 'warning' : 'primary'}>
              {t(attention ? 'launchesNeedsAttention' : 'launchesBusy')}
            </Badge>
          )}
          <span className="launch-card-context">
            <strong>{value.creativeAlias}</strong>
            <span> · {value.method === 'catalog' ? t('launchesCatalog') : t('launchesOther')}</span>
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
      </Button>
      {createdOn && (
        <div className="team-task-card-footer">
          <time
            className="team-task-card-date"
            dateTime={createdOn}
            title={t('teamTaskCreatedAt', { date: formatTaskDate(language, createdOn, true) })}
          >
            {formatTaskDate(language, createdOn)}
          </time>
        </div>
      )}
    </Card>
  );
}
