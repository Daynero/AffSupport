import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, MoreHorizontal } from 'lucide-react';
import { Button, IconButton, DropdownMenu } from '../../../components/ui/index';
import { TaskDateFilterControl } from '../../tasks/TaskDateFilter';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { useI18n } from '../../../i18n';

export function FinanceToolbar({
  date,
  compact = false,
  today,
  monthly,
  from,
  to,
  timezone,
  pending,
  exporting,
  canExport,
  navigate,
  onRange,
  onExport,
  mobileActions = []
}: {
  date: string;
  compact?: boolean;
  today: string;
  monthly: boolean;
  from: string;
  to: string;
  timezone: string;
  pending: boolean;
  exporting: boolean;
  canExport: boolean;
  navigate: (date: string, monthly: boolean) => void;
  onRange?: (from: string, to: string) => void;
  onExport: () => void;
  mobileActions?: readonly {
    id: string;
    label: string;
    disabled?: boolean;
    onSelect: () => void;
  }[];
}) {
  const { t } = useI18n();
  const [more, setMore] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const previousDay = new Date(`${today}T00:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const yesterday = previousDay.toISOString().slice(0, 10);
  const monthEnd = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const customRange =
    monthly && (from.slice(-2) !== '01' || to !== monthEnd.toISOString().slice(0, 10));
  const shiftRange = (direction: number): [string, string] => {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    return [from, to].map(day =>
      new Date(Date.parse(day) + days * direction * 86400000).toISOString().slice(0, 10)
    ) as [string, string];
  };
  const shiftPeriod = (direction: number) => {
    if (customRange && onRange) onRange(...shiftRange(direction));
    else navigate(shift(direction), monthly);
  };
  const shift = (direction: number) => {
    const next = new Date(`${monthly ? `${date.slice(0, 7)}-01` : date}T00:00:00Z`);
    if (monthly) next.setUTCMonth(next.getUTCMonth() + direction);
    else next.setUTCDate(next.getUTCDate() + direction);
    return next.toISOString().slice(0, 10);
  };
  const chooseMonth = (previous: boolean) => {
    const next = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    if (previous) next.setUTCMonth(next.getUTCMonth() - 1);
    navigate(next.toISOString().slice(0, 10), true);
  };
  return (
    <div className={`finance-toolbar flex flex-col gap-2${compact ? ' is-compact' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton
            title=""
            label={t('financePreviousPeriod')}
            disabled={pending}
            onClick={() => shiftPeriod(-1)}
          >
            <ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
          <TaskDateFilterControl
            value={{ kind: 'range', from, to }}
            status="all"
            onStatusChange={() => {}}
            showStatus={false}
            allowAll={false}
            disabled={pending}
            calendarLabel={from === to ? from : `${from} — ${to}`}
            onChange={value => {
              if (value.kind === 'range') {
                if (onRange) onRange(value.from, value.to);
                else navigate(value.from, value.from !== value.to);
              }
            }}
          />
          <IconButton
            title=""
            label={t('financeNextPeriod')}
            disabled={
              pending ||
              (customRange
                ? shiftRange(1)[0] > today
                : shift(1) > (monthly ? `${today.slice(0, 7)}-01` : today))
            }
            onClick={() => shiftPeriod(1)}
          >
            <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
        </div>
        <Button
          size="sm"
          variant="soft"
          data-finance-secondary="true"
          aria-pressed={!monthly && date === yesterday}
          color={!monthly && date === yesterday ? 'secondary' : 'neutral'}
          disabled={pending}
          onClick={() => navigate(yesterday, false)}
        >
          {t('financeYesterday')}
        </Button>
        <Button
          size="sm"
          variant="soft"
          data-finance-secondary="true"
          aria-pressed={!monthly && date === today}
          color={!monthly && date === today ? 'secondary' : 'neutral'}
          disabled={pending}
          onClick={() => navigate(today, false)}
        >
          {t('financeToday')}
        </Button>
        <Button
          size="sm"
          variant="soft"
          data-finance-secondary="true"
          aria-pressed={monthly && !customRange && date.slice(0, 7) === today.slice(0, 7)}
          color={
            monthly && !customRange && date.slice(0, 7) === today.slice(0, 7)
              ? 'secondary'
              : 'neutral'
          }
          disabled={pending}
          onClick={() => chooseMonth(false)}
        >
          {t('financeMonth')}
        </Button>
        <Button
          size="sm"
          variant="soft"
          data-finance-secondary="true"
          aria-pressed={monthly && !customRange && shift(1).slice(0, 7) === today.slice(0, 7)}
          color={
            monthly && !customRange && shift(1).slice(0, 7) === today.slice(0, 7)
              ? 'secondary'
              : 'neutral'
          }
          disabled={pending}
          onClick={() => chooseMonth(true)}
        >
          {t('financePrevious')}
        </Button>
        <Button
          size="sm"
          color="success"
          variant="soft"
          data-finance-secondary="true"
          loading={exporting}
          disabled={pending || !canExport}
          onClick={onExport}
          leading={<Download size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        >
          {t('financeExport')}
        </Button>
        {compact && (
          <span className="finance-mobile-menu">
            <IconButton ref={menu} label={t('actions')} onClick={() => setMore(value => !value)}>
              <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            </IconButton>
            <DropdownMenu
              label={t('actions')}
              open={more}
              anchor={menu}
              onClose={() => setMore(false)}
              items={[
                ...mobileActions,
                {
                  id: 'today',
                  label: t('financeToday'),
                  disabled: pending,
                  onSelect: () => navigate(today, false)
                },
                {
                  id: 'yesterday',
                  label: t('financeYesterday'),
                  disabled: pending,
                  onSelect: () => navigate(yesterday, false)
                },
                {
                  id: 'month',
                  label: t('financeMonth'),
                  disabled: pending,
                  onSelect: () => chooseMonth(false)
                },
                {
                  id: 'previous',
                  label: t('financePrevious'),
                  disabled: pending,
                  onSelect: () => chooseMonth(true)
                },
                {
                  id: 'export',
                  label: t('financeExport'),
                  disabled: pending || !canExport,
                  onSelect: onExport
                }
              ]}
            />
          </span>
        )}
      </div>
      <p className="text-label text-ink-muted">USD · {timezone}</p>
    </div>
  );
}
