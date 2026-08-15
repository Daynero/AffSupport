import type { TeamTaskStatus } from '@video-compressor/shared';
import type { Translate } from '../../components/ui';
import { useI18n } from '../../i18n';

export function taskStatusLabel(status: TeamTaskStatus, t: Translate): string {
  if (status === 'todo') return t('teamTaskStatusTodo');
  if (status === 'in_progress') return t('teamTaskStatusInProgress');
  return t('teamTaskStatusDone');
}

export function TaskStatusIcon({ status }: { status: TeamTaskStatus }) {
  if (status === 'todo') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M10 5.8v4.5l3 1.8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7" fill="currentColor" />
      <path
        d="m6.3 10.1 2.25 2.3 5.2-5.1"
        fill="none"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

const statuses: readonly TeamTaskStatus[] = ['todo', 'in_progress', 'done'];

export function TaskStatusControl({
  value,
  onChange,
  disabled = false,
  compact = false
}: {
  value: TeamTaskStatus;
  onChange: (status: TeamTaskStatus) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`team-task-status-control ${compact ? 'is-compact' : ''}`.trim()}
      aria-label={t('teamTaskStatus')}
    >
      {statuses.map(status => {
        const label = taskStatusLabel(status, t);
        return (
          <button
            key={status}
            type="button"
            className={`team-task-status-option is-${status} ${value === status ? 'is-selected' : ''}`.trim()}
            aria-label={label}
            aria-pressed={value === status}
            disabled={disabled}
            title={label}
            onClick={event => {
              event.stopPropagation();
              onChange(status);
            }}
          >
            <TaskStatusIcon status={status} />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
