/**
 * 064: the AI budget for the platform owner. One question first — how much of this month's money
 * is gone and where it is heading — answered by one bar: spent against the limit, with the
 * forecast and the worst case marked on the same scale. Under it, where the money went (one row
 * per paid feature) and the assistant's master switch; then the two limits as one form; then the
 * administrator's own credits. Everyone else's credits and the assistant pilot live next to each
 * space's tariff, which the footer points to rather than repeating.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { refreshCredits, useCredits } from '../../credits/store';
import { useOptionalAuth } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  FormField,
  HelpTip,
  InputNumber,
  Link,
  Progress,
  Switch,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { aiBudgetApi, type AiBudgetOverview } from '../../api/ai-budget';
import { teamErrorMessageFor } from '../../team/errors';

const CONSOLE_LIMITS_URL = 'https://console.anthropic.com/settings/limits';

function usd(value: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);
}

/** A share of the bar's scale, 0–1, for the fill and the marks on it. */
function at(value: number, scale: number): number {
  return scale > 0 ? Math.min(1, Math.max(0, value / scale)) : 0;
}

export function AiBudgetPanel({ onOpenTariffs }: { onOpenTariffs?: () => void }) {
  const { t, language } = useI18n();
  const ids = { month: useId(), limits: useId(), mine: useId(), features: useId() };
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
  const [limitsSaved, setLimitsSaved] = useState(false);
  // The administrator's own credits; everyone else's sit next to their tariff.
  const email = useOptionalAuth()?.user?.email ?? '';
  const mine = useCredits(Boolean(email)).status;
  const [grant, setGrant] = useState(Number.NaN);
  const [bonus, setBonus] = useState(Number.NaN);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback(
    (next: AiBudgetOverview) => {
      setOverview(next);
      setLimit(next.limitUsd);
      setBase(next.baseDailyGrant);
      const personal = next.grants.find(
        row => row.email.toLowerCase() === email.toLowerCase()
      )?.dailyGrant;
      setGrant(personal ?? Number.NaN);
    },
    [email]
  );

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
      return true;
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
      return false;
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

  // The bar's scale reaches whichever is furthest — the limit, the forecast or the worst case —
  // so a mark past the limit stands past the limit's mark instead of piling up at the end.
  const forecast = overview.forecastUsd;
  const scale = Math.max(overview.limitUsd, forecast ?? 0, overview.fullGrantUseUsd);
  const over = overview.fullGrantUseUsd > overview.limitUsd;
  const spentText = `${usd(overview.spentUsd, language)} ${t('aiBudgetOfLimit', {
    limit: usd(overview.limitUsd, language)
  })}`;
  const marks = [
    { key: 'limit', share: at(overview.limitUsd, scale) },
    ...(forecast === null ? [] : [{ key: 'forecast', share: at(forecast, scale) }]),
    { key: 'worst', share: at(overview.fullGrantUseUsd, scale) }
  ];

  const limitsChanged =
    (limit > 0 && limit !== overview.limitUsd) || (base >= 0 && base !== overview.baseDailyGrant);
  const limitsValid = limit > 0 && base >= 0;
  const saveLimits = async () => {
    setLimitsSaved(false);
    let ok = true;
    if (limit !== overview.limitUsd)
      ok = await run('limits', () => aiBudgetApi.setMonthLimit(limit));
    if (ok && base !== overview.baseDailyGrant)
      ok = await run('limits', () => aiBudgetApi.setBaseGrant(base));
    setLimitsSaved(ok);
  };

  return (
    <div className="admin-pool ai-budget">
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
        </div>

        <div className="ai-budget-meter">
          <p className="ai-budget-headline">
            <span className="ai-budget-headline-label">{t('aiBudgetSpentMonth')}</span>
            <span className="numeric">
              <strong>{usd(overview.spentUsd, language)}</strong>{' '}
              {t('aiBudgetOfLimit', { limit: usd(overview.limitUsd, language) })}
            </span>
          </p>
          <div className="ai-budget-track">
            <Progress
              value={at(overview.spentUsd, scale) * 100}
              color={overview.spentUsd >= overview.limitUsd ? 'error' : 'primary'}
              label={t('aiBudgetSpentMonth')}
              valueText={spentText}
            />
            {marks.map(mark => (
              <span
                key={mark.key}
                className={`ai-budget-mark ai-budget-mark--${mark.key}`}
                style={{ '--ai-budget-at': mark.share } as never}
                aria-hidden="true"
              />
            ))}
          </div>
          <dl className="ai-budget-legend">
            <div>
              <dt>{t('aiBudgetFree')}</dt>
              <dd className="numeric">{usd(overview.freeUsd, language)}</dd>
            </div>
            <div>
              <dt>
                <span className="ai-budget-key ai-budget-key--forecast" aria-hidden="true" />
                {t('aiBudgetForecast')}
              </dt>
              <dd className="numeric">
                {forecast === null ? t('aiBudgetForecastUnknown') : usd(forecast, language)}
              </dd>
            </div>
            <div>
              <dt>
                <span className="ai-budget-key ai-budget-key--worst" aria-hidden="true" />
                {t('aiBudgetFullGrant')}
                <HelpTip label={t('aiBudgetFullGrant')}>{t('aiBudgetFullGrantHint')}</HelpTip>
              </dt>
              <dd className="numeric">{usd(overview.fullGrantUseUsd, language)}</dd>
            </div>
            <div>
              <dt>
                <span className="ai-budget-key ai-budget-key--limit" aria-hidden="true" />
                {t('aiBudgetLimit')}
              </dt>
              <dd className="numeric">{usd(overview.limitUsd, language)}</dd>
            </div>
            <div>
              <dt>{t('aiBudgetRate')}</dt>
              <dd className="numeric">{t('aiBudgetRateValue', { usd: money(1) })}</dd>
            </div>
          </dl>
          {over && (
            <Alert color="warning" variant="soft">
              {t('aiBudgetOverWarning')}
            </Alert>
          )}
        </div>

        <Table
          size="sm"
          className="admin-table ai-budget-features"
          columns="minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr)"
          aria-labelledby={ids.features}
        >
          <TableHeader>
            <TableHeaderCell id={ids.features}>{t('aiBudgetColFeature')}</TableHeaderCell>
            <TableHeaderCell className="ai-budget-end">{t('aiBudgetColSpent')}</TableHeaderCell>
            <TableHeaderCell className="ai-budget-end">{t('aiBudgetColCharged')}</TableHeaderCell>
            <TableHeaderCell className="ai-budget-end">
              {t('aiBudgetColCoverage')}
              <HelpTip label={t('aiBudgetColCoverage')}>{t('aiBudgetCoverageHint')}</HelpTip>
            </TableHeaderCell>
          </TableHeader>
          {overview.byFeature.map(feature => (
            <TableRow key={feature.feature}>
              <TableCell>
                {t(
                  feature.feature === 'launch_assistant'
                    ? 'creditsFeatureAssistant'
                    : 'creditsFeatureTranslation'
                )}
              </TableCell>
              <TableCell className="ai-budget-end numeric">
                {usd(feature.spentUsd, language)}
                {feature.unknownCalls > 0 && (
                  <span className="ai-budget-cell-note">
                    {t('aiBudgetUnknownValue', { count: feature.unknownCalls })}
                  </span>
                )}
              </TableCell>
              <TableCell className="ai-budget-end numeric">
                {feature.chargedCredits > 0
                  ? t('aiBudgetChargedValue', {
                      credits: new Intl.NumberFormat(language).format(feature.chargedCredits),
                      usd: money(feature.chargedCredits)
                    })
                  : '—'}
              </TableCell>
              <TableCell className="ai-budget-end numeric">
                {feature.coverage === null || feature.spentUsd <= 0
                  ? '—'
                  : t('aiBudgetCoverageTimes', { times: feature.coverage.toFixed(1) })}
              </TableCell>
            </TableRow>
          ))}
        </Table>

        <div className="ai-budget-setting">
          <div>
            <strong>{t('aiBudgetAssistant')}</strong>
            <p>{t('aiBudgetAssistantHint')}</p>
          </div>
          <Switch
            checked={overview.assistantEnabled}
            disabled={busy !== null}
            label={t(overview.assistantEnabled ? 'aiBudgetAssistantOn' : 'aiBudgetAssistantOff')}
            aria-label={t('aiBudgetAssistant')}
            onChange={enabled =>
              void run('enabled', () => aiBudgetApi.setAssistantEnabled(enabled))
            }
          />
        </div>
      </Card>

      <Card className="admin-card" aria-labelledby={ids.limits}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.limits}>{t('aiBudgetLimitsTitle')}</h3>
            <p>{t('aiBudgetLimitsSubtitle')}</p>
          </div>
        </div>
        <form
          className="ai-budget-form"
          onSubmit={event => {
            event.preventDefault();
            if (limitsChanged && limitsValid) void saveLimits();
          }}
        >
          <div className="ai-budget-fields">
            <FormField
              label={t('aiBudgetLimit')}
              htmlFor={fieldIds.limit}
              help={t('aiBudgetLimitHelp')}
            >
              <InputNumber
                id={fieldIds.limit}
                min={1}
                value={limit}
                suffix={t('aiBudgetUnitUsd')}
                onChange={value => {
                  setLimit(value);
                  setLimitsSaved(false);
                }}
              />
            </FormField>
            <FormField
              label={t('aiBudgetBaseGrant')}
              htmlFor={fieldIds.base}
              help={
                base >= 0
                  ? t('aiBudgetBaseMoney', { day: money(base), month: money(base * 30) })
                  : undefined
              }
            >
              <InputNumber
                id={fieldIds.base}
                min={0}
                step={1}
                value={base}
                suffix={t('aiBudgetUnitPerDay')}
                onChange={value => {
                  setBase(value);
                  setLimitsSaved(false);
                }}
              />
            </FormField>
          </div>
          <div className="ai-budget-actions">
            <Button
              color="primary"
              type="submit"
              loading={busy === 'limits'}
              disabled={busy !== null || !limitsChanged || !limitsValid}
            >
              {t('adminTariffSave')}
            </Button>
            {limitsSaved && !limitsChanged && (
              <span className="ai-budget-saved" role="status">
                {t('aiBudgetSaved')}
              </span>
            )}
          </div>
        </form>
      </Card>

      <Card className="admin-card" aria-labelledby={ids.mine}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.mine}>{t('aiBudgetMineTitle')}</h3>
            <p>{t('aiBudgetMineSubtitle', { email })}</p>
          </div>
        </div>
        {mine && (
          <dl className="admin-pool-counts">
            <div>
              <dt>{t('aiBudgetMineAvailable')}</dt>
              <dd className="numeric">
                {mine.available}{' '}
                <span className="ai-budget-cell-note">≈ {money(mine.available)}</span>
              </dd>
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
          </dl>
        )}
        <div className="ai-budget-pair">
          <form
            className="ai-budget-form"
            onSubmit={event => {
              event.preventDefault();
              void run('grant', async () => {
                const next = await aiBudgetApi.setUserGrant(email, grant);
                void refreshCredits();
                return next;
              });
            }}
          >
            <FormField
              label={t('aiBudgetUserGrant')}
              htmlFor={fieldIds.grant}
              help={t('aiBudgetUserGrantHelp', { base: overview.baseDailyGrant })}
            >
              <InputNumber
                id={fieldIds.grant}
                min={0}
                step={1}
                value={grant}
                placeholder={String(overview.baseDailyGrant)}
                suffix={t('aiBudgetUnitPerDay')}
                onChange={setGrant}
              />
            </FormField>
            <div className="ai-budget-actions">
              <Button
                color="neutral"
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
                onClick={() =>
                  void run('reset', async () => {
                    const next = await aiBudgetApi.setUserGrant(email, null);
                    void refreshCredits();
                    return next;
                  })
                }
              >
                {t('aiBudgetReset')}
              </Button>
            </div>
          </form>
          <form
            className="ai-budget-form"
            onSubmit={event => {
              event.preventDefault();
              void run('bonus', async () => {
                const next = await aiBudgetApi.grantBonus(email, Math.trunc(bonus), null);
                setBonus(Number.NaN);
                // The header's balance shows the change at once.
                void refreshCredits();
                return next;
              });
            }}
          >
            <FormField
              label={t('aiBudgetBonus')}
              htmlFor={fieldIds.bonus}
              help={t('aiBudgetBonusHint')}
            >
              <InputNumber
                id={fieldIds.bonus}
                step={1}
                value={bonus}
                suffix={t('aiBudgetUnitCredits')}
                onChange={setBonus}
              />
            </FormField>
            <div className="ai-budget-actions">
              <Button
                color="neutral"
                type="submit"
                loading={busy === 'bonus'}
                disabled={busy !== null || !email || !bonus}
              >
                {t('aiBudgetBonusGive')}
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <ul className="ai-budget-links">
        <li>
          <Link href={CONSOLE_LIMITS_URL} target="_blank" rel="noreferrer" trailing="↗">
            {t('aiBudgetConsoleReminder')}
          </Link>
        </li>
        {onOpenTariffs && (
          <li>
            <Button variant="link" size="sm" onClick={onOpenTariffs}>
              {t('aiBudgetPeopleMoved')}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}
