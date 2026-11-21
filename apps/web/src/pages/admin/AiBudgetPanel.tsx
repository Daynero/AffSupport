/**
 * 064: the AI budget for the platform owner — the month's limit and real spend, what is still
 * available for new calls, the forecast, what full use of the grants could cost, how well the
 * prices cover the real cost, and the grants and the assistant pilot that drive it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, FormField, Input, Switch } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { aiBudgetApi, type AiBudgetOverview, type AiPilotSpace } from '../../api/ai-budget';
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
  const [overview, setOverview] = useState<AiBudgetOverview | null>(null);
  const [spaces, setSpaces] = useState<AiPilotSpace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState('');
  const [base, setBase] = useState('');
  const [email, setEmail] = useState('');
  const [grant, setGrant] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: AiBudgetOverview) => {
    setOverview(next);
    setLimit(String(next.limitUsd));
    setBase(String(next.baseDailyGrant));
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([aiBudgetApi.overview(), aiBudgetApi.spaces()])
      .then(([next, list]) => {
        if (!live) return;
        apply(next);
        setSpaces(list);
      })
      .catch(caught => live && setError(teamErrorMessageFor(caught, t)));
    return () => {
      live = false;
    };
  }, [apply, t]);

  const run = async (work: () => Promise<AiBudgetOverview | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) apply(next);
    } catch (caught) {
      setError(teamErrorMessageFor(caught, t));
    } finally {
      setBusy(false);
    }
  };

  if (!overview)
    return error ? (
      <Alert color="error" live="alert">
        {error}
      </Alert>
    ) : null;
  const over = overview.fullGrantUseUsd > overview.limitUsd;
  const figure = (label: string, value: string, hint?: string) => (
    <div className="ai-budget-figure">
      <span className="credits-panel-line">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="credits-panel-line">{hint}</span>}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert color="error" live="alert">
          {error}
        </Alert>
      )}
      <Card
        title={`${t('aiBudgetTitle')} · ${overview.month}`}
        aside={t('aiBudgetUpdated', {
          time: new Date(overview.updatedAt).toLocaleTimeString(language)
        })}
      >
        <div className="ai-budget-grid">
          {figure(t('aiBudgetLimit'), usd(overview.limitUsd, language))}
          {figure(t('aiBudgetSpent'), usd(overview.spentUsd, language), t('aiBudgetEstimate'))}
          {figure(t('aiBudgetFree'), usd(overview.freeUsd, language))}
          {figure(
            t('aiBudgetForecast'),
            overview.forecastUsd === null
              ? t('aiBudgetForecastUnknown')
              : usd(overview.forecastUsd, language)
          )}
          {figure(
            t('aiBudgetFullGrant'),
            usd(overview.fullGrantUseUsd, language),
            t('aiBudgetFullGrantHint')
          )}
        </div>
        {over && (
          <Alert color="warning" variant="soft">
            {t('aiBudgetOverWarning')}
          </Alert>
        )}
        <div className="ai-budget-grid">
          {overview.byFeature.map(feature =>
            figure(
              t(
                feature.feature === 'launch_assistant'
                  ? 'creditsFeatureAssistant'
                  : 'creditsFeatureTranslation'
              ),
              usd(feature.spentUsd, language),
              `${t('aiBudgetCoverage')}: ${feature.coverage ?? '—'} · ${t('aiBudgetUnknown')}: ${feature.unknownCalls}`
            )
          )}
        </div>
        <p className="credits-panel-line">{t('aiBudgetConsoleReminder')}</p>
      </Card>
      <Card title={t('aiBudgetLimit')}>
        <div className="ai-budget-grid">
          <FormField label={t('aiBudgetLimit')}>
            <Input
              type="number"
              min={1}
              value={limit}
              onChange={event => setLimit(event.target.value)}
            />
          </FormField>
          <Button
            size="sm"
            disabled={busy || !(Number(limit) > 0)}
            onClick={() => void run(() => aiBudgetApi.setMonthLimit(Number(limit)))}
          >
            {t('aiBudgetSet')}
          </Button>
          <FormField label={t('aiBudgetBaseGrant')}>
            <Input
              type="number"
              min={0}
              value={base}
              onChange={event => setBase(event.target.value)}
            />
          </FormField>
          <Button
            size="sm"
            disabled={busy || !(Number(base) >= 0)}
            onClick={() => void run(() => aiBudgetApi.setBaseGrant(Number(base)))}
          >
            {t('aiBudgetSet')}
          </Button>
        </div>
        <div className="ai-budget-grid">
          <FormField label={t('aiBudgetEmail')}>
            <Input type="email" value={email} onChange={event => setEmail(event.target.value)} />
          </FormField>
          <FormField label={t('aiBudgetUserGrant')}>
            <Input
              type="number"
              min={0}
              value={grant}
              onChange={event => setGrant(event.target.value)}
            />
          </FormField>
          <Button
            size="sm"
            disabled={busy || !email || grant === ''}
            onClick={() => void run(() => aiBudgetApi.setUserGrant(email, Number(grant)))}
          >
            {t('aiBudgetSet')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !email}
            onClick={() => void run(() => aiBudgetApi.setUserGrant(email, null))}
          >
            {t('aiBudgetReset')}
          </Button>
        </div>
        {overview.grants.length > 0 && (
          <ul className="credits-panel-recent">
            {overview.grants.map(row => (
              <li key={row.email}>{`${row.email} · ${row.dailyGrant}`}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('aiBudgetPilot')}>
        <Switch
          checked={overview.assistantEnabled}
          disabled={busy}
          label={t('aiBudgetAssistant')}
          onChange={enabled => void run(() => aiBudgetApi.setAssistantEnabled(enabled))}
        />
        <ul className="credits-panel-recent">
          {spaces.map(space => (
            <li key={space.teamId}>
              <Switch
                checked={space.pilot}
                disabled={busy}
                label={space.name}
                onChange={enabled =>
                  void run(async () => {
                    setSpaces(await aiBudgetApi.setSpace(space.teamId, enabled));
                  })
                }
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
