import type { LaunchDraft, LaunchSubConfig } from '@video-compressor/shared';
import { Button, Card } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/** Review a concurrent workspace change without replacing the Launch draft. */
export function LaunchDefaultsReview({
  current,
  offerName,
  buyer,
  disabled,
  onReview
}: {
  current: { config: LaunchDraft; subConfig: LaunchSubConfig } | null;
  offerName?: string;
  buyer: string;
  disabled: boolean;
  onReview: () => void;
}) {
  const { t } = useI18n();
  const config = current?.config;
  const variable = {
    buyer: t('launchesBuyer'),
    social: t('launchesSocial'),
    adAccountSuffix: t('launchesSuffix'),
    creative: t('launchesCreative')
  };
  const duration = config?.catalog?.finalDurationMode;
  const minutes =
    duration === 'custom'
      ? (config?.catalog?.customFinalDurationSeconds ?? 0) / 60
      : duration === 'random-centered'
        ? config?.catalog?.finalDurationRangeSeconds
          ? config.catalog.finalDurationRangeSeconds.map(n => n / 60).join('–')
          : `${Math.max(1, (config?.catalog?.customFinalDurationSeconds ?? 1800) / 60 - 5)}–${Math.min(60, (config?.catalog?.customFinalDurationSeconds ?? 1800) / 60 + 5)}`
        : duration === 'random-30-40'
          ? '30–40'
          : duration === 'random-40-50'
            ? '40–50'
            : '50–60';
  return (
    <Card
      role="section"
      title={
        offerName
          ? t('launchesDefaultsOfferConflict', { value: offerName })
          : t('launchesDefaultsConflict')
      }
    >
      <p>{t('launchesDefaultsReviewHelp')}</p>
      {config ? (
        <dl>
          <dt>{t('launchesBuyer')}</dt>
          <dd>{buyer || t('launchesSelect')}</dd>
          <dt>{t('launchesCampaignCount')}</dt>
          <dd>{config.campaignCount}</dd>
          <dt>{t('launchesBudget')}</dt>
          <dd>
            {config.minBudget === undefined
              ? config.maxBudget
              : `${config.minBudget}–${config.maxBudget}`}
          </dd>
          <dt>{t('launchesBudgetMode')}</dt>
          <dd>
            {t(config.budgetMode === 'manual' ? 'launchesCustomBudgets' : 'launchesAutomatic')}
          </dd>
          {config.budgetMode === 'manual' && <dd>{config.budgets?.join(' · ')}</dd>}
          <dt>{t('launchesAdsCount')}</dt>
          <dd>{config.adsCount}</dd>
          <dt>{t('launchesAge')}</dt>
          <dd>{config.age === undefined ? '—' : `${config.age}+`}</dd>
          <dt>{t('launchesGender')}</dt>
          <dd>{config.gender}</dd>
          <dt>{t('launchesMethod')}</dt>
          <dd>
            {t(config.method === 'catalog' ? 'launchesCatalog' : 'launchesOther')}
            {config.advantagePlus ? ` · ${t('launchesAdvantage')}` : ''}
          </dd>
          {config.method === 'catalog' && (
            <>
              <dt>{t('launchesProductCount')}</dt>
              <dd>{config.catalog?.productCount}</dd>
              <dt>{t('launchesRestitch')}</dt>
              <dd>
                {config.catalog?.restitchEnabled ? t('launchesDuration') + ': ' + minutes : '—'}
              </dd>
            </>
          )}
          {current &&
            (['sub1', 'sub2', 'sub3'] as const).map((slot, index) => (
              <div key={slot}>
                <dt>SUB {index + 1}</dt>
                <dd>
                  {current.subConfig[slot].map(key => variable[key]).join(' → ') ||
                    t('launchesPreserve')}
                </dd>
              </div>
            ))}
        </dl>
      ) : (
        <p>{t(offerName ? 'launchesDefaultsOfferMissing' : 'launchesDefaultsMissing')}</p>
      )}
      <Button disabled={disabled} onClick={onReview}>
        {t('launchesDefaultsReviewed')}
      </Button>
    </Card>
  );
}
