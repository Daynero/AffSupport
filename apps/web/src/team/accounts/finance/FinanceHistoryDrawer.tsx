import { useEffect, useState } from 'react';
import { financeRecord } from '@video-compressor/shared';
import { Button, Drawer, ErrorState, LoadingState } from '../../../components/ui/index';
import { teamFinanceApi } from '../../../api/team-finance';
import { useI18n } from '../../../i18n';
import { formatFinanceAmount } from './formatFinanceAmount';
import { AgentIdentity } from '../AgentIdentity';

export function FinanceHistoryDrawer({
  teamId,
  agent,
  accountName,
  agentId,
  onClose,
  onReviewLegacy
}: {
  teamId: string;
  agent: string;
  accountName: string;
  agentId: string;
  onClose: () => void;
  onReviewLegacy?: () => void;
}) {
  const { t, language } = useI18n();
  const formatDate = (value: unknown, withTime = false) => {
    const raw = String(value ?? '');
    const date = new Date(withTime ? raw : `${raw}T12:00:00+03:00`);
    if (!raw || Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
      timeZone: 'Europe/Kyiv',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      ...(withTime ? ({ hour: '2-digit', minute: '2-digit', second: '2-digit' } as const) : {})
    }).format(date);
  };
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<{ time: string; id: string } | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [legacy, setLegacy] = useState<Record<string, unknown>[]>([]);
  useEffect(() => {
    let active = true;
    void teamFinanceApi
      .legacy(teamId, agent)
      .then(rows => {
        if (active) setLegacy(rows);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [teamId, agent]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void teamFinanceApi
      .history(teamId, agent, cursor)
      .then(data => {
        if (!active) return;
        const events: Record<string, unknown>[] = [];
        if (Array.isArray(data.events))
          for (const event of data.events) if (financeRecord(event)) events.push(event);
        const transfers: Record<string, unknown>[] = [];
        if (Array.isArray(data.transfers))
          for (const event of data.transfers) if (financeRecord(event)) transfers.push(event);
        setRows(old =>
          [...old, ...events, ...transfers].sort(
            (a, b) =>
              String(b.occurred_at).localeCompare(String(a.occurred_at)) ||
              String(b.id).localeCompare(String(a.id))
          )
        );
        const c = data.nextCursor;
        setCursor(
          financeRecord(c) && typeof c.time === 'string' && typeof c.id === 'string'
            ? { time: c.time, id: c.id }
            : undefined
        );
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // Cursor is consumed only when the person requests another page.
  }, [teamId, agent, page]);
  return (
    <Drawer
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          {t('financeHistory')} · <AgentIdentity accountName={accountName} agentId={agentId} />
        </span>
      }
    >
      {legacy.length > 0 && (
        <section>
          <h4>{t('financeLegacy')}</h4>
          <p>{t('financeLegacyHelp')}</p>
          {legacy.map((row, index) => (
            <p key={typeof row.id === 'string' ? row.id : index}>
              {t('financeBalance')}: {formatFinanceAmount(row.balance_units)} · {t('financeTopup')}:{' '}
              {formatFinanceAmount(row.requested_topup_units)}
            </p>
          ))}
          {onReviewLegacy && <Button onClick={onReviewLegacy}>{t('financeImport')}</Button>}
        </section>
      )}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((r, i) => (
          <li
            className="flex flex-col gap-2 rounded-md border border-neutral-border p-3"
            key={typeof r.id === 'string' ? r.id : i}
          >
            <div className="flex min-w-0 items-center gap-2 text-caption">
              <span className="shrink-0 font-medium">
                {r.metric === 'balance'
                  ? t('financeBalance')
                  : r.metric === 'topup'
                    ? t('financeTopup')
                    : r.metric === 'spend'
                      ? t('financeSpend')
                      : t('financeMove')}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-ink-muted"
                title={String(r.actor_name ?? r.actor_id ?? '')}
              >
                {String(r.actor_name ?? r.actor_id ?? '')}
              </span>
              <time
                className="shrink-0 whitespace-nowrap text-ink-muted tabular-nums"
                dateTime={String(r.occurred_at ?? '')}
              >
                {formatDate(r.occurred_at, true)}
              </time>
            </div>
            <p className="m-0 text-label text-ink-muted">
              {Boolean(r.metric) && `${String(r.account_name ?? '')} · `}
              <time dateTime={String(r.entry_date ?? r.effective_on ?? '')}>
                {formatDate(r.entry_date ?? r.effective_on)}
              </time>
            </p>
            <div
              className="flex items-center gap-2 tabular-nums"
              title={formatDate(r.entry_date ?? r.effective_on)}
            >
              {r.metric ? (
                <>
                  <span className="text-ink-muted">{formatFinanceAmount(r.oldValue)}</span>
                  <span aria-hidden="true">→</span>
                  <span className="font-medium">{formatFinanceAmount(r.newValue)}</span>
                  <span className="text-caption text-ink-muted">USD</span>
                </>
              ) : (
                `${String(r.from_account ?? '')} → ${String(r.to_account ?? '')}`
              )}{' '}
            </div>
          </li>
        ))}
      </ol>
      {loading && <LoadingState label={t('financeHistory')} />}
      {error && (
        <ErrorState
          message={t('financeError')}
          onRetry={() => setPage(p => p + 1)}
          retryLabel={t('retry')}
        />
      )}
      {cursor && !loading && (
        <Button onClick={() => setPage(p => p + 1)}>{t('financeHistory')}</Button>
      )}
    </Drawer>
  );
}
