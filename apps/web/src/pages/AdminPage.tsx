import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../components/ui';
import { formatSize } from '../format';
import { useI18n, type TranslationKey } from '../i18n';
import type { AdminUserRow, Json, MarketingExportRow } from '../lib/database.types';
import { requireSupabaseClient } from '../lib/supabase';

type AdminOverview = {
  total_users: number;
  new_users_24h: number;
  new_users_7d: number;
  new_users_30d: number;
  active_users_7d: number;
  active_users_30d: number;
  marketing_consent_users: number;
  agent_connections: number;
  compressor_opens: number;
  compression_batches: number;
  successful_compressions: number;
  failed_compressions: number;
  total_videos: number;
  total_input_bytes: number;
  total_output_bytes: number;
  total_saved_bytes: number;
  average_saving_percent: number;
  optimal_batches: number;
  custom_batches: number;
  image_embedding_batches: number;
  videos_optimal: number;
  videos_custom: number;
  videos_with_image: number;
};

type DailyActivity = { activity_date: string; active_users: number; event_count: number };
type UsageRow = { category: string; label: string; total: number };
type AgentVersionRow = { agent_version: string; total: number };

const overviewKeys: (keyof AdminOverview)[] = [
  'total_users',
  'new_users_24h',
  'new_users_7d',
  'new_users_30d',
  'active_users_7d',
  'active_users_30d',
  'marketing_consent_users',
  'agent_connections',
  'compressor_opens',
  'compression_batches',
  'successful_compressions',
  'failed_compressions',
  'total_videos',
  'total_input_bytes',
  'total_output_bytes',
  'total_saved_bytes',
  'average_saving_percent',
  'optimal_batches',
  'custom_batches',
  'image_embedding_batches',
  'videos_optimal',
  'videos_custom',
  'videos_with_image'
];

export function parseAdminOverview(value: Json): AdminOverview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, Json | undefined>;
  const output = {} as AdminOverview;
  for (const key of overviewKeys) {
    const raw = source[key];
    const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(numeric)) return null;
    output[key] = numeric;
  }
  return output;
}

const metricLabels: Record<keyof AdminOverview, TranslationKey> = {
  total_users: 'metricTotalUsers',
  new_users_24h: 'metricNew24h',
  new_users_7d: 'metricNew7d',
  new_users_30d: 'metricNew30d',
  active_users_7d: 'metricActive7d',
  active_users_30d: 'metricActive30d',
  marketing_consent_users: 'metricConsent',
  agent_connections: 'metricAgentConnections',
  compressor_opens: 'metricCompressorOpens',
  compression_batches: 'metricBatches',
  successful_compressions: 'metricSuccessful',
  failed_compressions: 'metricFailed',
  total_videos: 'metricVideos',
  total_input_bytes: 'metricInputSize',
  total_output_bytes: 'metricOutputSize',
  total_saved_bytes: 'metricSavedSize',
  average_saving_percent: 'metricAverageSaving',
  optimal_batches: 'metricOptimal',
  custom_batches: 'metricCustom',
  image_embedding_batches: 'metricEmbedding',
  videos_optimal: 'metricVideosOptimal',
  videos_custom: 'metricVideosCustom',
  videos_with_image: 'metricVideosWithImage'
};

const sizeMetrics = new Set<keyof AdminOverview>([
  'total_input_bytes',
  'total_output_bytes',
  'total_saved_bytes'
]);

function csvCell(value: string) {
  const formulaSafe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export function marketingCsv(rows: MarketingExportRow[]) {
  const header = ['email', 'display_name', 'language', 'marketing_consent_at'];
  return [
    header.join(','),
    ...rows.map(row =>
      [row.email, row.display_name ?? '', row.language, row.marketing_consent_at]
        .map(csvCell)
        .join(',')
    )
  ].join('\n');
}

export default function AdminPage() {
  const { isAdmin, user } = useAuth();
  const { language, t } = useI18n();
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [daily, setDaily] = useState<DailyActivity[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [consentFilter, setConsentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pageSize = 20;

  useEffect(() => {
    document.title = `${t('adminTitle')} — Wishly`;
  }, [t]);

  const dates = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - range * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, [range]);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(false);
    const supabase = requireSupabaseClient();
    const args = { p_start_date: dates.start, p_end_date: dates.end };
    const consent = consentFilter === '' ? null : consentFilter === 'true';
    const [overviewResult, dailyResult, usageResult, versionsResult, usersResult] =
      await Promise.all([
        supabase.rpc('admin_overview', args),
        supabase.rpc('admin_daily_activity', args),
        supabase.rpc('admin_tool_usage', args),
        supabase.rpc('admin_agent_versions', args),
        supabase.rpc('admin_list_users', {
          p_search: search,
          p_marketing_consent: consent,
          p_account_status: statusFilter || null,
          p_limit: pageSize,
          p_offset: page * pageSize
        })
      ]);
    const failed = [overviewResult, dailyResult, usageResult, versionsResult, usersResult].some(
      result => result.error
    );
    const parsedOverview = overviewResult.data ? parseAdminOverview(overviewResult.data) : null;
    if (failed || !parsedOverview) {
      setError(true);
    } else {
      setOverview(parsedOverview);
      setDaily(dailyResult.data ?? []);
      setUsage(usageResult.data ?? []);
      setVersions(versionsResult.data ?? []);
      setUsers(usersResult.data ?? []);
    }
    setLoading(false);
  }, [consentFilter, dates.end, dates.start, isAdmin, page, search, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isAdmin) {
    return (
      <main className="admin-forbidden page-container">
        <h2>{t('adminForbiddenTitle')}</h2>
        <p>{t('adminForbiddenBody')}</p>
      </main>
    );
  }

  const totalUsers = Number(users[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const number = new Intl.NumberFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    maximumFractionDigits: 1
  });
  const metricValue = (key: keyof AdminOverview, value: number) => {
    if (sizeMetrics.has(key)) return formatSize(value, language);
    if (key === 'average_saving_percent') return `${number.format(value)}%`;
    return number.format(value);
  };

  const exportConsent = async () => {
    setExporting(true);
    setError(false);
    const { data, error: exportError } =
      await requireSupabaseClient().rpc('admin_marketing_export');
    if (exportError) setError(true);
    else {
      const blob = new Blob([`\uFEFF${marketingCsv(data ?? [])}`], {
        type: 'text/csv;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `wishly-marketing-consent-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    setExporting(false);
  };

  const changeStatus = async (target: AdminUserRow) => {
    const nextStatus = target.account_status === 'blocked' ? 'active' : 'blocked';
    const { error: statusError } = await requireSupabaseClient().rpc('admin_set_account_status', {
      p_user_id: target.id,
      p_account_status: nextStatus
    });
    if (statusError) setError(true);
    else void load();
  };

  return (
    <main className="admin-page page-container">
      <header className="page-heading admin-heading">
        <div>
          <h2>{t('adminTitle')}</h2>
          <p>{t('adminSubtitle')}</p>
        </div>
        <div className="admin-range" aria-label={t('dateRange')}>
          {([7, 30, 90] as const).map(value => (
            <button
              type="button"
              key={value}
              className={range === value ? 'is-active' : ''}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {t(`range${value}` as TranslationKey)}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="inline-alert inline-alert-error" role="alert">
          {t('adminError')}
          <Button variant="ghost" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {loading && !overview ? (
        <div className="admin-loading" role="status">
          {t('loading')}
        </div>
      ) : overview ? (
        <>
          <section className="metric-grid" aria-label={t('adminTitle')}>
            {overviewKeys.map(key => (
              <article className="metric-card" key={key}>
                <span>{t(metricLabels[key])}</span>
                <strong>{metricValue(key, overview[key])}</strong>
              </article>
            ))}
          </section>

          <section className="admin-card activity-card" aria-labelledby="activity-heading">
            <div className="admin-card-heading">
              <h3 id="activity-heading">{t('dailyActivity')}</h3>
              <div className="chart-legend">
                <span>
                  <i className="legend-users" />
                  {t('activeUsers')}
                </span>
                <span>
                  <i className="legend-events" />
                  {t('events')}
                </span>
              </div>
            </div>
            <ActivityChart data={daily} />
          </section>

          <div className="admin-split-grid">
            <Breakdown
              title={t('toolUsage')}
              rows={usage.map(row => ({
                label: `${row.category} · ${row.label}`,
                total: row.total
              }))}
              empty={t('adminEmpty')}
            />
            <Breakdown
              title={t('agentVersions')}
              rows={versions.map(row => ({ label: row.agent_version, total: row.total }))}
              empty={t('adminEmpty')}
            />
          </div>

          <section className="admin-card users-card" aria-labelledby="users-heading">
            <div className="admin-card-heading users-heading">
              <h3 id="users-heading">{t('latestUsers')}</h3>
              <Button loading={exporting} onClick={() => void exportConsent()}>
                {exporting ? t('exporting') : t('exportConsent')}
              </Button>
            </div>
            <form
              className="admin-filters"
              onSubmit={event => {
                event.preventDefault();
                setPage(0);
                setSearch(searchInput.trim());
              }}
            >
              <label className="field search-field">
                <span>{t('searchEmail')}</span>
                <input value={searchInput} onChange={event => setSearchInput(event.target.value)} />
              </label>
              <label className="field">
                <span>{t('consent')}</span>
                <select
                  value={consentFilter}
                  onChange={event => {
                    setPage(0);
                    setConsentFilter(event.target.value);
                  }}
                >
                  <option value="">{t('allConsent')}</option>
                  <option value="true">{t('consented')}</option>
                  <option value="false">{t('notConsented')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('accountStatus')}</span>
                <select
                  value={statusFilter}
                  onChange={event => {
                    setPage(0);
                    setStatusFilter(event.target.value);
                  }}
                >
                  <option value="">{t('allStatuses')}</option>
                  <option value="active">{t('activeStatus')}</option>
                  <option value="blocked">{t('blockedStatus')}</option>
                  <option value="deleted">{t('deletedStatus')}</option>
                </select>
              </label>
              <Button type="submit" variant="primary">
                {t('search')}
              </Button>
            </form>

            {users.length ? (
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('email')}</th>
                      <th>{t('displayName')}</th>
                      <th>{t('joined')}</th>
                      <th>{t('lastActive')}</th>
                      <th>{t('consent')}</th>
                      <th>{t('accountStatus')}</th>
                      <th>{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(row => (
                      <tr key={row.id}>
                        <td>{row.email ?? t('notAvailable')}</td>
                        <td>{row.display_name ?? '—'}</td>
                        <td>
                          {new Date(row.created_at).toLocaleDateString(
                            language === 'uk' ? 'uk-UA' : 'en-US'
                          )}
                        </td>
                        <td>
                          {row.last_seen_at
                            ? new Date(row.last_seen_at).toLocaleDateString(
                                language === 'uk' ? 'uk-UA' : 'en-US'
                              )
                            : t('never')}
                        </td>
                        <td>{row.marketing_consent ? t('consented') : t('notConsented')}</td>
                        <td>
                          <span className={`account-status status-${row.account_status}`}>
                            {t(statusKey(row.account_status))}
                          </span>
                        </td>
                        <td>
                          {row.id !== user?.id && row.account_status !== 'deleted' && (
                            <Button variant="ghost" onClick={() => void changeStatus(row)}>
                              {t(row.account_status === 'blocked' ? 'unblockUser' : 'blockUser')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-empty">{t('adminEmpty')}</div>
            )}
            <div className="pagination">
              <Button
                disabled={page === 0}
                onClick={() => setPage(value => Math.max(0, value - 1))}
              >
                {t('previous')}
              </Button>
              <span>{t('pageOf', { page: page + 1, pages })}</span>
              <Button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>
                {t('next')}
              </Button>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

function statusKey(status: string): TranslationKey {
  if (status === 'blocked') return 'blockedStatus';
  if (status === 'deleted') return 'deletedStatus';
  return 'activeStatus';
}

function ActivityChart({ data }: { data: DailyActivity[] }) {
  const maximum = Math.max(1, ...data.flatMap(day => [day.active_users, day.event_count]));
  return (
    <div className="activity-chart" role="img" aria-label="Daily active users and events">
      {data.map(day => (
        <div
          className="activity-day"
          key={day.activity_date}
          title={`${day.activity_date}: ${day.active_users} / ${day.event_count}`}
        >
          <span
            className="activity-bar events-bar"
            style={{ height: `${(day.event_count / maximum) * 100}%` }}
          />
          <span
            className="activity-bar users-bar"
            style={{ height: `${(day.active_users / maximum) * 100}%` }}
          />
          <time dateTime={day.activity_date}>
            {new Date(`${day.activity_date}T00:00:00Z`).getUTCDate()}
          </time>
        </div>
      ))}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  empty
}: {
  title: string;
  rows: { label: string; total: number }[];
  empty: string;
}) {
  return (
    <section className="admin-card breakdown-card">
      <h3>{title}</h3>
      {rows.length ? (
        <ul>
          {rows.map(row => (
            <li key={`${row.label}-${row.total}`}>
              <span>{row.label}</span>
              <strong>{row.total}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
