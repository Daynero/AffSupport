/**
 * 064: the AI budget for the platform owner, laid out like the other admin tabs (the image pool
 * of 052): the month at a glance, the two limits, people (a personal daily grant and bonus
 * credits by email, and who holds what), and the assistant pilot as a list with «Прибрати» and a
 * search to add — not a switch per space.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { refreshCredits } from '../../credits/store';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Switch,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';
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
  const ids = { month: useId(), limits: useId(), people: useId(), pilot: useId() };
  const fieldIds = {
    limit: useId(),
    base: useId(),
    email: useId(),
    grant: useId(),
    bonus: useId(),
    search: useId()
  };
  const [overview, setOverview] = useState<AiBudgetOverview | null>(null);
  const [spaces, setSpaces] = useState<AiPilotSpace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState('');
  const [base, setBase] = useState('');
  const [email, setEmail] = useState('');
  const [grant, setGrant] = useState('');
  const [bonus, setBonus] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

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
  const people = new Map<string, { grant: number | null; bonus: number }>();
  for (const row of overview.grants)
    people.set(row.email, { grant: row.dailyGrant, bonus: people.get(row.email)?.bonus ?? 0 });
  for (const row of overview.bonuses)
    people.set(row.email, { grant: people.get(row.email)?.grant ?? null, bonus: row.balance });
  const pilot = spaces.filter(space => space.pilot);
  const needle = query.trim().toLowerCase();
  const found =
    needle.length < 2
      ? []
      : spaces
          .filter(space => !space.pilot && space.name.toLowerCase().includes(needle))
          .slice(0, 8);
  const setSpace = (space: AiPilotSpace, enabled: boolean) =>
    run(`space:${space.teamId}`, async () => {
      setSpaces(await aiBudgetApi.setSpace(space.teamId, enabled));
      setQuery('');
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
            <h3 id={ids.month}>{`${t('aiBudgetTitle')} · ${overview.month}`}</h3>
            <p>
              {t('aiBudgetUpdated', {
                time: new Date(overview.updatedAt).toLocaleTimeString(language, {
                  hour: '2-digit',
                  minute: '2-digit'
                })
              })}
            </p>
          </div>
          <Badge color={overview.assistantEnabled ? 'success' : 'neutral'}>
            {t(overview.assistantEnabled ? 'aiBudgetAssistantOn' : 'aiBudgetAssistantOff')}
          </Badge>
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
              ['aiBudgetFullGrant', usd(overview.fullGrantUseUsd, language)]
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd className="numeric">{value}</dd>
            </div>
          ))}
        </dl>
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
                {`${usd(feature.spentUsd, language)} · ${t('aiBudgetCoverage')} ${feature.coverage ?? '—'} · ${t('aiBudgetUnknown')} ${feature.unknownCalls}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="ai-budget-note">{t('aiBudgetConsoleReminder')}</p>
      </Card>

      <Card className="admin-card" aria-labelledby={ids.limits}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.limits}>{t('aiBudgetLimitsTitle')}</h3>
            <p>{t('aiBudgetLimitsSubtitle')}</p>
          </div>
        </div>
        <form
          className="release-testers-form"
          onSubmit={event => {
            event.preventDefault();
            void run('limit', () => aiBudgetApi.setMonthLimit(Number(limit)));
          }}
        >
          <FormField label={t('aiBudgetLimitUsd')} htmlFor={fieldIds.limit}>
            <Input
              id={fieldIds.limit}
              type="number"
              min={1}
              value={limit}
              onChange={event => setLimit(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            loading={busy === 'limit'}
            disabled={busy !== null || !(Number(limit) > 0)}
          >
            {t('aiBudgetSet')}
          </Button>
        </form>
        <form
          className="release-testers-form"
          onSubmit={event => {
            event.preventDefault();
            void run('base', () => aiBudgetApi.setBaseGrant(Number(base)));
          }}
        >
          <FormField label={t('aiBudgetBaseGrant')} htmlFor={fieldIds.base}>
            <Input
              id={fieldIds.base}
              type="number"
              min={0}
              value={base}
              onChange={event => setBase(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            loading={busy === 'base'}
            disabled={busy !== null || !(Number(base) >= 0)}
          >
            {t('aiBudgetSet')}
          </Button>
        </form>
      </Card>

      <Card className="admin-card" aria-labelledby={ids.people}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.people}>{t('aiBudgetPeopleTitle')}</h3>
            <p>{t('aiBudgetPeopleSubtitle')}</p>
          </div>
        </div>
        <div className="release-testers-form">
          <FormField label={t('aiBudgetEmail')} htmlFor={fieldIds.email}>
            <Input
              id={fieldIds.email}
              type="email"
              autoComplete="off"
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </FormField>
        </div>
        <form
          className="release-testers-form"
          onSubmit={event => {
            event.preventDefault();
            void run('grant', () => aiBudgetApi.setUserGrant(email, Number(grant)));
          }}
        >
          <FormField label={t('aiBudgetUserGrant')} htmlFor={fieldIds.grant}>
            <Input
              id={fieldIds.grant}
              type="number"
              min={0}
              value={grant}
              onChange={event => setGrant(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            loading={busy === 'grant'}
            disabled={busy !== null || !email || grant === ''}
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
              const next = await aiBudgetApi.grantBonus(email, Math.trunc(Number(bonus)), null);
              setBonus('');
              // When it was the administrator's own balance, the header shows it at once.
              void refreshCredits();
              return next;
            });
          }}
        >
          <FormField
            label={t('aiBudgetBonus')}
            hint={t('aiBudgetBonusHint')}
            htmlFor={fieldIds.bonus}
          >
            <Input
              id={fieldIds.bonus}
              type="number"
              value={bonus}
              onChange={event => setBonus(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            loading={busy === 'bonus'}
            disabled={busy !== null || !email || !Number(bonus)}
          >
            {t('aiBudgetBonusGive')}
          </Button>
        </form>
        {people.size > 0 ? (
          <Table className="admin-table" aria-label={t('aiBudgetPeopleTitle')}>
            <TableHeader>
              <TableHeaderCell>{t('aiBudgetEmail')}</TableHeaderCell>
              <TableHeaderCell>{t('aiBudgetUserGrant')}</TableHeaderCell>
              <TableHeaderCell>{t('aiBudgetBonus')}</TableHeaderCell>
            </TableHeader>
            {[...people.entries()].map(([who, row]) => (
              <TableRow key={who}>
                <TableCell>{who}</TableCell>
                <TableCell>
                  <span className="numeric">
                    {row.grant ?? t('aiBudgetGrantBase', { count: overview.baseDailyGrant })}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="numeric">{row.bonus || '—'}</span>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        ) : (
          <EmptyState className="admin-empty" size="sm" title={t('aiBudgetPeopleEmpty')} />
        )}
      </Card>

      <Card className="admin-card" aria-labelledby={ids.pilot}>
        <div className="admin-card-heading">
          <div>
            <h3 id={ids.pilot}>{t('aiBudgetPilot')}</h3>
            <p>{t('aiBudgetPilotSubtitle')}</p>
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
        {pilot.length ? (
          <ul className="admin-pool-teams">
            {pilot.map(space => (
              <li key={space.teamId}>
                <span>{space.name}</span>
                <Button
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  loading={busy === `space:${space.teamId}`}
                  disabled={busy !== null}
                  onClick={() => void setSpace(space, false)}
                >
                  {t('aiBudgetPilotRemove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState className="admin-empty" size="sm" title={t('aiBudgetPilotEmpty')} />
        )}
        <FormField label={t('aiBudgetPilotSearch')} htmlFor={fieldIds.search}>
          <Input
            id={fieldIds.search}
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </FormField>
        {found.length > 0 && (
          <ul className="admin-pool-teams">
            {found.map(space => (
              <li key={space.teamId}>
                <span>{space.name}</span>
                <Button
                  size="sm"
                  color="primary"
                  variant="soft"
                  loading={busy === `space:${space.teamId}`}
                  disabled={busy !== null}
                  onClick={() => void setSpace(space, true)}
                >
                  {t('aiBudgetPilotAdd')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
