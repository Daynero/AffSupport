import { useCallback, useEffect, useMemo, useState } from 'react';
import { financeToday, type TeamAccountOverview } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Button, ErrorState, Input, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { financeMonthRange } from './finance/FinanceWorkspace';

type OverviewClient = Pick<typeof teamApi, 'getAccountLaunchFinanceOverview'>;

function validPeriod(from: string, to: string): boolean {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return (
    Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < 366 * 86400000
  );
}

export function AccountLaunchFinanceTable({
  teamId,
  revision,
  client = teamApi
}: {
  teamId: string;
  revision: number;
  client?: OverviewClient;
}) {
  const { t } = useI18n();
  const today = financeToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [initialFrom, initialTo] = financeMonthRange(today);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [period, setPeriod] = useState({ from: initialFrom, to: initialTo });
  const [data, setData] = useState<TeamAccountOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry(value => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    void client.getAccountLaunchFinanceOverview(teamId, period.from, period.to).then(
      overview => {
        if (current) {
          setData(overview);
          setLoading(false);
        }
      },
      () => {
        if (current) {
          setError(true);
          setLoading(false);
        }
      }
    );
    return () => {
      current = false;
    };
  }, [client, teamId, period, revision, retry]);

  const rowsBySocial = useMemo(() => {
    const index = new Map<string, string[]>();
    const add = (socialId: string, agentId: string) => {
      const rows = index.get(socialId) ?? [];
      if (!rows.includes(agentId)) rows.push(agentId);
      index.set(socialId, rows);
    };
    for (const agent of data?.agents ?? []) add(agent.socialId, agent.id);
    for (const row of data?.finance ?? []) add(row.socialId, row.agentRowId);
    for (const launch of data?.launches ?? []) {
      if (launch.association !== 'unmatched' && launch.snapshotSocialId && launch.agentRowId)
        add(launch.snapshotSocialId, launch.agentRowId);
    }
    return index;
  }, [data]);
  const money = (value: number | null) =>
    value === null ? t('accountOverviewNoData') : `${(value / 100).toFixed(2)} USD`;
  const unmatched = data?.launches.filter(row => row.association === 'unmatched') ?? [];

  return (
    <section className="account-overview" aria-label={t('accountOverviewTitle')}>
      <form
        className="account-overview-period"
        onSubmit={event => {
          event.preventDefault();
          if (validPeriod(from, to)) setPeriod({ from, to });
        }}
      >
        <label>
          {t('accountOverviewFrom')}
          <Input type="date" value={from} onChange={event => setFrom(event.target.value)} />
        </label>
        <label>
          {t('accountOverviewTo')}
          <Input type="date" value={to} onChange={event => setTo(event.target.value)} />
        </label>
        <Button type="submit" size="sm" variant="soft" disabled={!validPeriod(from, to)}>
          {t('accountOverviewApply')}
        </Button>
        {!validPeriod(from, to) && <span role="alert">{t('accountOverviewPeriodInvalid')}</span>}
      </form>
      {loading && !data && <LoadingState shape="row" count={3} label={t('teamAccountsLoading')} />}
      {error && (
        <ErrorState
          message={t('accountOverviewLoadFailed')}
          onRetry={refresh}
          retryLabel={t('retry')}
        />
      )}
      {data && !error && !loading && (
        <>
          {data.socials.length === 0 && unmatched.length === 0 && (
            <p>{t('accountOverviewEmpty')}</p>
          )}
          {data.socials.map(social => (
            <section key={social.id} className="account-overview-social" aria-label={social.name}>
              <h3>{social.name}</h3>
              {(rowsBySocial.get(social.id) ?? []).map(agentId => {
                const launches = data.launches.filter(
                  launch =>
                    launch.agentRowId === agentId &&
                    launch.snapshotSocialId === social.id &&
                    launch.association !== 'unmatched'
                );
                const placements = data.finance.filter(
                  row => row.agentRowId === agentId && row.socialId === social.id
                );
                const agent = data.agents.find(row => row.id === agentId);
                return (
                  <div key={agentId} className="account-overview-agent">
                    <h4>{agent?.agentId ?? agentId}</h4>
                    <div className="account-overview-figures">
                      {placements.map(row => (
                        <div key={row.placementId}>
                          <span>
                            {row.startsOn}
                            {row.endsOn ? ` — ${row.endsOn}` : ''}
                          </span>
                          <span>
                            {t('financeBalance')}: {money(row.balanceCents)}
                          </span>
                          <span>
                            {t('financeTopup')}: {money(row.topupCents)}
                          </span>
                          <span>
                            {t('financeSpend')}: {money(row.spendCents)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {launches.length > 0 && (
                      <div className="account-overview-launches">
                        <strong>{t('accountOverviewLaunches')}</strong>
                        {launches.map(launch => (
                          <p key={launch.id}>
                            {launch.launchDate ?? '—'} · {launch.offer} · {launch.creativeAlias}
                            {launch.association === 'moved' && ` · ${t('accountOverviewMoved')}`}
                            {launch.archived && ` · ${t('accountOverviewArchived')}`}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          {unmatched.length > 0 && (
            <section className="account-overview-social" aria-label={t('accountOverviewUnmatched')}>
              <h3>{t('accountOverviewUnmatched')}</h3>
              {unmatched.map(launch => (
                <p key={launch.id}>
                  {launch.launchDate ?? '—'} · {launch.offer} · {launch.creativeAlias} ·{' '}
                  {t(
                    launch.unmatchedReason === 'missing_agent'
                      ? 'accountOverviewMissingAgent'
                      : 'accountOverviewMissingSocial'
                  )}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
