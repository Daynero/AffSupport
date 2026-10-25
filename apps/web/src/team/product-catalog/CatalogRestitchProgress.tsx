import { useMemo } from 'react';
import { teamApi } from '../../api/team';
import { Alert, Progress } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { CatalogUpdateProgress } from '../catalog-updater/CatalogUpdateProgress';
import { teamErrorMessageFor } from '../errors';
import { useTeamOperation } from '../processing/useTeamOperation';

/** Observe the existing child operation; missing evidence stays indeterminate. */
export function CatalogRestitchProgress({
  teamId,
  operationId,
  client
}: {
  teamId: string;
  operationId: string | null;
  client?: Partial<Pick<typeof teamApi, 'getOperation' | 'cancelOperation'>>;
}) {
  const { t } = useI18n();
  const observer = useMemo(
    () => ({
      getOperation: client?.getOperation ?? teamApi.getOperation,
      cancelOperation: client?.cancelOperation ?? teamApi.cancelOperation
    }),
    [client?.getOperation, client?.cancelOperation]
  );
  const observed = useTeamOperation({
    teamId,
    operationId,
    client: observer,
    workspaceObservation: true
  });
  const operation =
    observed.operation?.id === operationId && observed.operation.teamId === teamId
      ? observed.operation
      : null;
  const state = operationId ? (observed.localState ?? operation?.state) : null;
  if (state === 'failed')
    return (
      <Alert color="error" variant="soft" live="alert" title={t('teamOperationFailed')}>
        {teamErrorMessageFor(
          { code: observed.localErrorCode ?? operation?.errorCode ?? 'PROCESS_FAILED' },
          t
        )}
      </Alert>
    );
  if (state === 'canceled') return <p role="status">{t('teamOperationCanceled')}</p>;

  const values = [operation?.progress, observed.localProgress?.progress].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  const measured =
    operationId &&
    !observed.streamDisconnected &&
    (state === 'running' || state === 'succeeded') &&
    values.length > 0
      ? Math.min(100, Math.max(0, ...values))
      : null;
  if (measured !== null) {
    const stage = observed.localProgress?.stage ?? operation?.stage;
    const known = (['downloading', 'processing', 'uploading', 'finalizing'] as const).find(
      value => value === stage
    );
    return (
      <CatalogUpdateProgress
        stage="restitching"
        restitchProgress={measured}
        restitchStage={state === 'succeeded' ? 'finalizing' : (known ?? 'processing')}
      />
    );
  }
  return (
    <div className="product-catalog-progress is-compact" role="status">
      <p className="product-catalog-progress-step">{t('productCatalogRestitching')}</p>
      <Progress
        className="product-catalog-restitch-indeterminate"
        color="secondary"
        size="sm"
        label={t('catalogUpdaterVideoProgress')}
      />
    </div>
  );
}
