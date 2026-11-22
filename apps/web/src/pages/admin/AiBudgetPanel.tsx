/**
 * 064: the AI budget for the platform owner, laid out like the other admin tabs (the image pool
 * of 052): the month at a glance, the two limits, people (a personal daily grant and bonus
 * credits by email, and who holds what), and the assistant pilot as a list with «Прибрати» and a
 * search to add — not a switch per space.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { refreshCredits, useCredits } from '../../credits/store';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Alert, Button, Card, FormField, InputNumber, Switch } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { aiBudgetApi, type AiBudgetOverview } from '../../api/ai-budget';
import { teamErrorMessageFor } from '../../team/errors';

function usd(value: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);
}

export function AiBudgetPanel() {
  const { t, language } = useI18n();
  const ids = { month: useId(), limits: useId(), people: useId() };
  const fieldIds = {
    limit: useId(),
    base: useId(),
    grant: useId(),
    bonus: useId()
  };
  const [overview, setOverview] = useState<AiBudgetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(Number.NaN);
  const [base, setBase] = useState(Number.NaN);
  // «Люди» is the administrator alone now: everyone else's credits sit next to their tariff.
  const email = useOptionalAuth()?.user?.email ?? '';
  const mine = useCredits(Boolean(email)).status;
  const [grant, setGrant] = useState(Number.NaN);
  const [bonus, setBonus] = useState(Number.NaN);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((next: AiBudgetOverview) => {
    setOverview(next);
    setLimit(next.limitUsd);
    setBase(next.baseDailyGrant);
  }, []);

  useEffect(() => {
    let live = true;
    aiBudgetApi
      .overview()
      .then(next => {
        if (live) apply(next);
      })
      .catch(caught => live && setError(teamErrorMessageFor(caught, t)));
    return () => {
      live = false;
    };
  }, [apply, t]);

  // One action at a time; only its own button shows that it is working.
  const run = async (name: string, work: () => Promise<AiBudgetOverview | void>) => {
    setBusy(name);
    setError(null);
    try {
      const next = await work();
      if (next) apply(next);
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
    } finally {
      setBusy(null);
    }
  };

  if (!overview)
    return error ? (
      <Alert color="error" live="alert">
        {error}
      </Alert>
    ) : null;

  const over = overview.fullGrantUseUsd > overview.limitUsd;
  // Credits in money, at the price the server sets: «100 ≈ $0.10».
  const rate = overview.creditUsd;
  const money = (credits: number) =>
    new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: credits * rate < 1 ? 3 : 2,
      maximumFractionDigits: credits * rate < 1 ? 3 : 2
    }).format(credits * rate);
  const monthName = new Date(`${overview.month}-15T12:00:00Z`).toLocaleDateString(language, {
    month: 'long',
    year: 'numeric'
  });

  return (
    <div className="admin-pool">
      {error && (
        <Alert color="error" live="alert">
          {error}
        </Alert>
      )}

      <Card className="admin-card" aria-labelledby={ids.month}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.month}>{`${t('aiBudgetTitle')} · ${monthName}`}</h3>
            <p>
              {t('aiBudgetMonthSubtitle', {
                time: new Date(overview.updatedAt).toLocaleTimeString(language, {
                  hour: '2-digit',
                  minute: '2-digit'
                })
              })}
            </p>
          </div>
          <Switch
            checked={overview.assistantEnabled}
            disabled={busy !== null}
            label={t('aiBudgetAssistant')}
            onChange={enabled =>
              void run('enabled', () => aiBudgetApi.setAssistantEnabled(enabled))
            }
          />
        </div>
        <dl className="admin-pool-counts">
          {(
            [
              ['aiBudgetLimit', usd(overview.limitUsd, language)],
              ['aiBudgetSpent', usd(overview.spentUsd, language)],
              ['aiBudgetFree', usd(overview.freeUsd, language)],
              [
                'aiBudgetForecast',
                overview.forecastUsd === null
                  ? t('aiBudgetForecastUnknown')
                  : usd(overview.forecastUsd, language)
              ],
              ['aiBudgetFullGrant', usd(overview.fullGrantUseUsd, language)],
              ['aiBudgetRate', t('aiBudgetRateValue', { usd: money(1) })]
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd className="numeric">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="ai-budget-note">{t('aiBudgetFullGrantHint')}</p>
        {over && (
          <Alert color="warning" variant="soft">
            {t('aiBudgetOverWarning')}
          </Alert>
        )}
        <ul className="admin-pool-jobs">
          {overview.byFeature.map(feature => (
            <li key={feature.feature}>
              <span>
                {t(
                  feature.feature === 'launch_assistant'
                    ? 'creditsFeatureAssistant'
                    : 'creditsFeatureTranslation'
                )}
              </span>
              <span className="numeric">
                {[
                  usd(feature.spentUsd, language),
                  feature.coverage === null
                    ? null
                    : t('aiBudgetCoverageValue', { times: feature.coverage.toFixed(2) }),
                  feature.unknownCalls > 0
                    ? t('aiBudgetUnknownValue', { count: feature.unknownCalls })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
        <p className="ai-budget-note">{t('aiBudgetConsoleReminder')}</p>
        <p className="ai-budget-note">{t('aiBudgetPeopleMoved')}</p>
      </Card>

      <Card className="admin-card" aria-labelledby={ids.limits}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.limits}>{t('aiBudgetLimitsTitle')}</h3>
            <p>{t('aiBudgetLimitsSubtitle')}</p>
          </div>
        </div>
        <div className="ai-budget-forms">
          <form
            className="release-testers-form"
            onSubmit={event => {
              event.preventDefault();
              void run('limit', () => aiBudgetApi.setMonthLimit(limit));
            }}
          >
            <FormField label={t('aiBudgetLimitUsd')} htmlFor={fieldIds.limit}>
              <InputNumber id={fieldIds.limit} min={1} value={limit} onChange={setLimit} />
            </FormField>
            <Button
              type="submit"
              loading={busy === 'limit'}
              disabled={busy !== null || !(limit > 0)}
            >
              {t('aiBudgetSet')}
            </Button>
          </form>
          <form
            className="release-testers-form"
            onSubmit={event => {
              event.preventDefault();
              void run('base', () => aiBudgetApi.setBaseGrant(base));
            }}
          >
            <FormField label={t('aiBudgetBaseGrant')} htmlFor={fieldIds.base}>
              <InputNumber id={fieldIds.base} min={0} step={1} value={base} onChange={setBase} />
            </FormField>
            <Button
              type="submit"
              loading={busy === 'base'}
              disabled={busy !== null || !(base >= 0)}
            >
              {t('aiBudgetSet')}
            </Button>
          </form>
        </div>
        {base >= 0 && (
          <p className="ai-budget-note">
            {t('aiBudgetBaseMoney', {
              count: base,
              day: money(base),
              month: money(base * 30)
            })}
          </p>
        )}
      </Card>

      <Card className="admin-card" aria-labelledby={ids.people}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.people}>{t('aiBudgetMineTitle')}</h3>
            <p>{email}</p>
          </div>
        </div>
        {mine && (
          <dl className="admin-pool-counts">
            <div>
              <dt>{t('aiBudgetMineAvailable')}</dt>
              <dd className="numeric">{mine.available}</dd>
            </div>
            <div>
              <dt>{t('creditsDaily')}</dt>
              <dd className="numeric">
                {t('creditsOf', { value: mine.daily, grant: mine.grant })}
              </dd>
            </div>
            <div>
              <dt>{t('creditsBonus')}</dt>
              <dd className="numeric">{mine.bonus}</dd>
            </div>
            <div>
              <dt>{t('aiBudgetMineMoney')}</dt>
              <dd className="numeric">{money(mine.available)}</dd>
            </div>
          </dl>
        )}
        <div className="ai-budget-forms">
          <form
            className="release-testers-form"
            onSubmit={event => {
              event.preventDefault();
              void run('grant', () => aiBudgetApi.setUserGrant(email, grant));
            }}
          >
            <FormField label={t('aiBudgetUserGrant')} htmlFor={fieldIds.grant}>
              <InputNumber id={fieldIds.grant} min={0} step={1} value={grant} onChange={setGrant} />
            </FormField>
            <Button
              type="submit"
              loading={busy === 'grant'}
              disabled={busy !== null || !email || !(grant >= 0)}
            >
              {t('aiBudgetSet')}
            </Button>
            <Button
              variant="ghost"
              loading={busy === 'reset'}
              disabled={busy !== null || !email}
              onClick={() => void run('reset', () => aiBudgetApi.setUserGrant(email, null))}
            >
              {t('aiBudgetReset')}
            </Button>
          </form>
          <form
            className="release-testers-form"
            onSubmit={event => {
              event.preventDefault();
              void run('bonus', async () => {
                const next = await aiBudgetApi.grantBonus(email, Math.trunc(bonus), null);
                setBonus(Number.NaN);
                // When it was the administrator's own balance, the header shows it at once.
                void refreshCredits();
                return next;
              });
            }}
          >
            <FormField label={t('aiBudgetBonus')} htmlFor={fieldIds.bonus}>
              <InputNumber id={fieldIds.bonus} step={1} value={bonus} onChange={setBonus} />
            </FormField>
            <Button
              type="submit"
              loading={busy === 'bonus'}
              disabled={busy !== null || !email || !bonus}
            >
              {t('aiBudgetBonusGive')}
            </Button>
          </form>
        </div>
        <p className="ai-budget-note">{t('aiBudgetBonusHint')}</p>
      </Card>
    </div>
  );
}
