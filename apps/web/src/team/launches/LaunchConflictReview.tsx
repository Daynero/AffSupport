import type { LaunchDetail } from '@video-compressor/shared';
import { Button, Card } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { LaunchResult } from './LaunchResult';

export function LaunchConflictReview({
  current,
  disabled,
  decisionDisabled,
  canKeep,
  onReload,
  onKeep,
  onTake
}: {
  current: LaunchDetail | null;
  disabled: boolean;
  decisionDisabled: boolean;
  canKeep: boolean;
  onReload: () => void;
  onKeep: () => void;
  onTake: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card role="section" title={t('launchesConflictTitle')}>
      <p>{t('launchesConflictHelp')}</p>
      <Button disabled={disabled} onClick={onReload}>
        {t('teamTextEditorReload')}
      </Button>
      {current && (
        <>
          <p>
            {t('launchesCampaignCount')}: {current.draft.campaignCount} · {t('launchesMaxBudget')}:{' '}
            {current.draft.maxBudget} · {t('launchesDate')}: {current.draft.launchDate}
          </p>
          <p>
            {t('launchesAlias')}: {current.draft.creativeAlias} · {current.draft.gender}
            {current.draft.age}+ ·{' '}
            {t(current.draft.method === 'catalog' ? 'launchesCatalog' : 'launchesOther')}
            {current.draft.advantagePlus ? ` · ${t('launchesAdvantage')}` : ''}
          </p>
          {current.activeRevision && (
            <LaunchResult
              revision={current.activeRevision}
              overrides={current.activeRevision.overrides}
              editable={false}
              disabled={false}
              launchId={current.id}
              onChange={() => {}}
              onSave={() => {}}
            />
          )}
          {!canKeep && <p className="text-warning-text">{t('launchesConflictBaselineChanged')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled || decisionDisabled || !canKeep} onClick={onKeep}>
              {t('launchesConflictKeep')}
            </Button>
            <Button variant="ghost" disabled={disabled || decisionDisabled} onClick={onTake}>
              {t('launchesConflictTake')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
