import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Button, IconButton } from '../../../components/ui/index';
import { TaskDateFilterControl } from '../../tasks/TaskDateFilter';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { useI18n } from '../../../i18n';

export function FinanceToolbar({
  date,
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
  onExport
}: {
  date: string;
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
}) {
  const { t } = useI18n();
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
    <div className="flex flex-col gap-2">
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
          loading={exporting}
          disabled={pending || !canExport}
          onClick={onExport}
          leading={<Download size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        >
          {t('financeExport')}
        </Button>
      </div>
      <p className="text-label text-ink-muted" title={t('financeTimezone', { timezone })}>
        USD · {timezone}
      </p>
    </div>
  );
}
