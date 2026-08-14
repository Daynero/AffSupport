import { useI18n } from '../../i18n';
import { Button } from '../../components/ui';
import { localDateValue, type TaskDateFilter } from './useTasks';

export function TaskDateFilterControl({
  value,
  onChange
}: {
  value: TaskDateFilter;
  onChange: (value: TaskDateFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="task-date-filter" aria-label={t('teamTasksDateFilter')}>
      <Button
        type="button"
        variant={value.kind === 'today' ? 'primary' : 'secondary'}
        aria-pressed={value.kind === 'today'}
        onClick={() => onChange({ kind: 'today' })}
      >
        {t('teamTasksToday')}
      </Button>
      <Button
        type="button"
        variant={value.kind === 'yesterday' ? 'primary' : 'secondary'}
        aria-pressed={value.kind === 'yesterday'}
        onClick={() => onChange({ kind: 'yesterday' })}
      >
        {t('teamTasksYesterday')}
      </Button>
      <Button
        type="button"
        variant={value.kind === 'all' ? 'primary' : 'secondary'}
        aria-pressed={value.kind === 'all'}
        onClick={() => onChange({ kind: 'all' })}
      >
        {t('teamTasksAllTime')}
      </Button>
      <label>
        <span>{t('teamTasksCalendar')}</span>
        <input
          type="date"
          value={value.kind === 'date' ? value.date : ''}
          max={localDateValue(new Date())}
          onChange={event => {
            if (event.target.value) onChange({ kind: 'date', date: event.target.value });
          }}
        />
      </label>
    </div>
  );
}
