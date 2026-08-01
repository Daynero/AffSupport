import type { TeamOperationSnapshot } from '../../api/team';
import { Button, ProgressBar } from '../../components/ui';
import { useI18n } from '../../i18n';

export interface LocalTeamProgress {
  stage: string;
  progress: number;
}

export function OperationStatus({
  operation,
  localProgress,
  onCancel,
  onRetry
}: {
  operation: TeamOperationSnapshot;
  localProgress: LocalTeamProgress | null;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const running = operation.state === 'pending' || operation.state === 'running';
  const progress = Math.max(operation.progress, running ? (localProgress?.progress ?? 0) : 0);
  const stage = running && localProgress ? localProgress.stage : operation.stage;

  return (
    <section className={`team-operation-status is-${operation.state}`} aria-live="polite">
      <div className="team-operation-status-heading">
        <strong>{operationLabel(operation.state, t)}</strong>
        <span>{Math.round(progress)}%</span>
      </div>
      <ProgressBar value={progress} active={running} label={t('teamOperationProgressLabel')} />
      <small>{stageLabel(stage, t)}</small>
      {operation.errorCode && <p className="team-inline-error">{operation.errorCode}</p>}
      <div className="team-material-action-buttons">
        {running && (
          <Button type="button" variant="ghost" onClick={() => void onCancel()}>
            {t('teamOperationCancel')}
          </Button>
        )}
        {operation.state === 'failed' && operation.retryable && (
          <Button type="button" variant="secondary" onClick={() => void onRetry()}>
            {t('teamOperationRetry')}
          </Button>
        )}
      </div>
    </section>
  );
}

function operationLabel(state: TeamOperationSnapshot['state'], t: ReturnType<typeof useI18n>['t']) {
  if (state === 'succeeded') return t('teamOperationSucceeded');
  if (state === 'failed') return t('teamOperationFailed');
  if (state === 'canceled') return t('teamOperationCanceled');
  return t('teamOperationRunning');
}

function stageLabel(stage: string, t: ReturnType<typeof useI18n>['t']) {
  const known: Record<string, string> = {
    downloading: t('teamOperationDownloading'),
    processing: t('teamOperationProcessing'),
    uploading: t('teamOperationUploading'),
    finalizing: t('teamOperationFinalizing'),
    completed: t('teamOperationSucceeded')
  };
  return known[stage] ?? stage.replaceAll('_', ' ');
}
