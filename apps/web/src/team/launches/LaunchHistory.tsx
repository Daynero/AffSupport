import { Button, Card, Badge } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { launchApi } from '../../api/launches';
export function LaunchHistory({
  rows,
  editable,
  disabled,
  confirming,
  decisionBusy,
  savePending,
  onView,
  onRestore,
  onSave,
  onDiscard,
  onCancel
}: {
  rows: Awaited<ReturnType<typeof launchApi.history>>;
  editable: boolean;
  disabled: boolean;
  confirming: boolean;
  decisionBusy: boolean;
  savePending: boolean;
  onView: (id: string) => void;
  onRestore: (id: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const { t, language } = useI18n();
  return (
    <>
      {confirming && (
        <Card role="section" title={t('launchesRestore')}>
          <p>{t('launchesRestoreUnsaved')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="success" disabled={!editable || decisionBusy} onClick={onSave}>
              {t('launchesSaveRestore')}
            </Button>
            <Button
              variant="ghost"
              disabled={!editable || decisionBusy || savePending}
              onClick={onDiscard}
            >
              {t('launchesDiscardRestore')}
            </Button>
            <Button variant="ghost" disabled={decisionBusy || savePending} onClick={onCancel}>
              {t('launchesCancel')}
            </Button>
          </div>
        </Card>
      )}
      {rows.map(row => {
        const date = new Date(row.createdAt);
        const label = Number.isFinite(date.getTime())
          ? new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(
              date
            )
          : '—';
        return (
          <div key={row.id} className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={disabled || (row.kind === 'generated' && row.state !== 'succeeded')}
              onClick={() => onView(row.id)}
            >
              #{row.revisionNo} · {label}
            </Button>
            <Badge
              color={row.kind === 'manual' || row.state === 'succeeded' ? 'success' : 'warning'}
            >
              {t(
                row.kind === 'manual'
                  ? 'launchesManual'
                  : row.state === 'succeeded'
                    ? 'launchesReady'
                    : row.state === 'canceled'
                      ? 'teamOperationCanceled'
                      : 'launchesNeedsAttention'
              )}
            </Badge>
            {editable && (
              <Button disabled={disabled} onClick={() => onRestore(row.id)}>
                {t('launchesRestore')}
              </Button>
            )}
          </div>
        );
      })}
    </>
  );
}
