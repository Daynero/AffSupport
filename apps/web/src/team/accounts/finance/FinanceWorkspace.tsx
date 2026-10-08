import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildFinanceReport,
  buildFinanceTopupCopy,
  FINANCE_METRICS,
  type TeamAccountAgentSummary,
  type TeamTaskLabel
} from '@video-compressor/shared';
import {
  IconButton,
  SearchField,
  ErrorState,
  LoadingState,
  ConfirmDialog,
  Modal,
  Button
} from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { useToasts } from '../../../components/toast';
import { teamFinanceApi } from '../../../api/team-finance';
import { useAgentFinance } from './useAgentFinance';
import { DailyFinanceField } from './DailyFinanceFields';
import { MoveAgentDialog } from './MoveAgentDialog';
import { FinanceHistoryDrawer } from './FinanceHistoryDrawer';
import { formatFinanceAmount } from './formatFinanceAmount';
import { LegacyFinanceReview } from './LegacyFinanceReview';
import { copyText } from '../../../two-factor/clipboard';
import { useFinancePeriod } from './useFinancePeriod';
import { MonthlyFinanceSummary, type MonthlyFinanceContext } from './MonthlyFinanceSummary';
import { FinanceToolbar } from './FinanceToolbar';
import { FinanceActions } from './FinanceActions';
import { History, Copy } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { teamErrorMessageFor } from '../../errors';
import { BEFORE_NAVIGATION_EVENT, navigateTo } from '../../../lib/navigation';
import { AgentIdentity } from '../AgentIdentity';
import { AgentLabels } from '../AgentLabels';
import { FinanceAccountGroup } from './FinanceAccountGroup';

export function financeMonthRange(date: string): [string, string] {
  const first = `${date.slice(0, 7)}-01`;
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return [first, d.toISOString().slice(0, 10)];
}

export function FinanceWorkspace({
  teamId,
  canEdit,
  revision,
  agents = [],
  labels = [],
  onToggleLabel
}: {
  teamId: string;
  canEdit: boolean;
  revision: number;
  agents?: readonly TeamAccountAgentSummary[];
  labels?: readonly TeamTaskLabel[];
  onToggleLabel?: (agent: TeamAccountAgentSummary, labelId: string, next: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [drafts, setDrafts] = useState<Record<string, 'dirty' | 'pending'>>({});
  const [clear, setClear] = useState<{
    metric: 'balance' | 'topup';
    date: string;
    timezone: string;
    fields: { agent: string; expectedVersion: string }[];
    request: string;
  } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const saveActions = useRef(new Map<string, () => Promise<boolean>>());
  const clearDrafts = useRef(new Set<string>());
  const [confirmSave, setConfirmSave] = useState<null | { continueNavigation: boolean }>(null);
  const onRegisterSave = useCallback(
    (key: string, action: (() => Promise<boolean>) | null, clears = false) => {
      if (action) saveActions.current.set(key, action);
      else saveActions.current.delete(key);
      if (action && clears) clearDrafts.current.add(key);
      else clearDrafts.current.delete(key);
    },
    []
  );
  const dirty = Object.keys(drafts).length > 0;
  const pending = Object.values(drafts).includes('pending') || clearing || savingAll;
  const { date, setDate, today, timezone } = useFinancePeriod(dirty || clear !== null);
  const onStateChange = useCallback((key: string, state: 'clean' | 'dirty' | 'pending') => {
    setDrafts(old => {
      if (old[key] === state || (state === 'clean' && !(key in old))) return old;
      const next = { ...old };
      if (state === 'clean') delete next[key];
      else next[key] = state;
      return next;
    });
  }, []);
  const [navigation, setNavigation] = useState<{
    date: string;
    monthly: boolean;
    range?: [string, string];
  } | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [routeNavigation, setRouteNavigation] = useState<{
    path: string;
    replace: boolean;
    animate: boolean;
  } | null>(null);
  const allowRoute = useRef(false);
  useEffect(() => {
    const before = (event: Event) => {
      if (!dirty || allowRoute.current) return;
      if (!(event instanceof CustomEvent) || typeof event.detail?.path !== 'string') return;
      event.preventDefault();
      if (!pending)
        setRouteNavigation({
          path: event.detail.path,
          replace: event.detail.replace === true,
          animate: event.detail.animate !== false
        });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener(BEFORE_NAVIGATION_EVENT, before);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATION_EVENT, before);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, pending]);
  const [monthly, setMonthly] = useState(false);
  const [selectedRange, setSelectedRange] = useState<[string, string] | null>(null);
  const monthlyContext = useRef<MonthlyFinanceContext | undefined>(undefined);
  const [returnMonth, setReturnMonth] = useState<string | null>(null);
  const returnRange = useRef<[string, string] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<string | null>(null);
  const [from, to] = monthly ? (selectedRange ?? financeMonthRange(date)) : [date, date];
  const liveFinance = useAgentFinance(teamId, from, to, timezone, revision);
  const topology = useRef(liveFinance.snapshot);
  // Moving a row between account groups unmounts its local editors. Preserve
  // the grouping until drafts are saved/discarded, while values still refresh.
  if (!dirty) topology.current = liveFinance.snapshot;
  const retained = topology.current;
  const draftAgents = new Set(Object.keys(drafts).map(key => key.split('/')[0]));
  const retainedPlacements = retained?.placements.filter(p => draftAgents.has(p.agentRowId)) ?? [];
  const placements = [
    ...(liveFinance.snapshot?.placements.filter(p => !draftAgents.has(p.agentRowId)) ?? []),
    ...retainedPlacements
  ];
  const finance = {
    ...liveFinance,
    snapshot:
      dirty &&
      liveFinance.snapshot &&
      retained &&
      retained.teamId === teamId &&
      retained.from === from &&
      retained.to === to
        ? {
            ...liveFinance.snapshot,
            accounts: [
              ...liveFinance.snapshot.accounts,
              ...retained.accounts.filter(
                account =>
                  retainedPlacements.some(p => p.accountId === account.id) &&
                  !liveFinance.snapshot!.accounts.some(a => a.id === account.id)
              )
            ],
            agents: [
              ...liveFinance.snapshot.agents,
              ...retained.agents.filter(
                agent =>
                  draftAgents.has(agent.id) &&
                  !liveFinance.snapshot!.agents.some(a => a.id === agent.id)
              )
            ],
            placements,
            fields: liveFinance.snapshot.fields.filter(field =>
              placements.some(placement => placement.id === field.placementId)
            )
          }
        : liveFinance.snapshot
  };
  const movedDraft =
    dirty &&
    retained &&
    liveFinance.snapshot &&
    Object.keys(drafts).some(key => {
      const agent = key.split('/')[0];
      const old = retained.placements.find(
        p => p.agentRowId === agent && p.startsOn <= date && (p.endsOn === null || date < p.endsOn)
      );
      const current = liveFinance.snapshot!.placements.find(
        p => p.agentRowId === agent && p.startsOn <= date && (p.endsOn === null || date < p.endsOn)
      );
      return old?.id !== current?.id;
    });
  const report = useMemo(
    () => (finance.snapshot ? buildFinanceReport(finance.snapshot) : null),
    [finance.snapshot]
  );
  const fail = (cause?: unknown) =>
    push({ tone: 'error', text: cause ? teamErrorMessageFor(cause, t) : t('financeError') });
  const beginClear = (metric: 'balance' | 'topup') => {
    const fields =
      finance.snapshot?.fields
        .filter(f => f.date === date && f.metric === metric && f.value !== null)
        .map(f => ({ agent: f.agentRowId, expectedVersion: f.version })) ?? [];
    if (!fields.length) {
      push({ tone: 'info', text: t('financeEmpty') });
      return;
    }
    setClear({ metric, date, timezone, fields, request: crypto.randomUUID() });
  };
  const navigate = (next: string, month: boolean, range?: [string, string]) => {
    if (pending) return;
    if (dirty) {
      setNavigation({ date: next, monthly: month, range });
      return;
    }
    setDate(next);
    setMonthly(month);
    setSelectedRange(range ?? null);
  };
  const finishNavigation = () => {
    if (navigation) {
      setDrafts({});
      setDraftEpoch(e => e + 1);
      setDate(navigation.date);
      setMonthly(navigation.monthly);
      setSelectedRange(navigation.range ?? null);
      setNavigation(null);
    } else if (routeNavigation) {
      allowRoute.current = true;
      navigateTo(routeNavigation.path, routeNavigation.replace, routeNavigation.animate);
    }
  };
  const saveAll = async (continueNavigation = false) => {
    if (pending) return;
    const actions = Object.keys(drafts).map(key => saveActions.current.get(key));
    if (actions.some(action => !action)) return;
    setSavingAll(true);
    try {
      const results = await Promise.all(actions.map(action => action!()));
      if (results.every(Boolean) && continueNavigation) finishNavigation();
    } finally {
      setSavingAll(false);
    }
  };
  const requestSave = (continueNavigation = false) => {
    if (pending) return;
    if (clearDrafts.current.size) setConfirmSave({ continueNavigation });
    else void saveAll(continueNavigation);
  };
  return (
    <section className="flex flex-col gap-4" aria-label={t('financeTitle')}>
      <h3>{t('financeTitle')}</h3>
      <FinanceToolbar
        date={date}
        today={today}
        monthly={monthly}
        from={from}
        to={to}
        timezone={timezone}
        pending={pending}
        exporting={exporting}
        canExport={Boolean(finance.snapshot)}
        navigate={navigate}
        onRange={(start, end) => {
          if (start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 365) {
            push({ tone: 'info', text: t('financeRangeLimit') });
            return;
          }
          navigate(start, start !== end, start === end ? undefined : [start, end]);
        }}
        onExport={() => {
          setExporting(true);
          void teamFinanceApi
            .export(teamId, from, to, timezone)
            .catch(fail)
            .finally(() => setExporting(false));
        }}
      />
      {!monthly && returnMonth && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => navigate(returnMonth, true, returnRange.current)}
        >
          {t('financeReturnMonth')}
        </Button>
      )}
      {!monthly && (
        <SearchField
          aria-label={t('financeSearch')}
          placeholder={t('financeSearch')}
          value={query}
          onChange={setQuery}
          disabled={dirty}
        />
      )}
      {!monthly && finance.snapshot && (
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <FinanceActions
              label={t('financePeriodActions')}
              disabled={dirty}
              items={[
                {
                  id: 'clear-balance',
                  label: t('financeClearBalance'),
                  destructive: true,
                  onSelect: () => beginClear('balance')
                },
                {
                  id: 'clear-topup',
                  label: t('financeClearTopup'),
                  destructive: true,
                  onSelect: () => beginClear('topup')
                }
              ]}
            />
          )}
          <Button
            size="sm"
            variant="soft"
            trailing={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            onClick={() => {
              if (!finance.snapshot) return;
              const contents = buildFinanceTopupCopy(
                finance.snapshot,
                'label',
                Object.fromEntries(
                  agents.map(agent => [agent.id, agent.labels.map(label => label.name)])
                ),
                t('teamAgentLabelsUntagged'),
                date
              );
              if (!contents.count) {
                push({ tone: 'info', text: t('financeEmpty') });
                return;
              }
              void copyText(contents.text)
                .then(ok => {
                  if (ok)
                    push({
                      tone: 'success',
                      text: t('teamAccountsCopied', { count: contents.count })
                    });
                  else fail();
                })
                .catch(fail);
            }}
          >
            {t('financeCopy')}
          </Button>
        </div>
      )}
      {finance.loading && <LoadingState label={t('financeTitle')} />}
      {finance.error && (
        <ErrorState
          message={t('financeError')}
          onRetry={finance.refresh}
          retryLabel={t('financeSave')}
        />
      )}
      {report && finance.snapshot && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-label">
            <span>{from === to ? from : `${from} — ${to}`}</span>
            {(['spend', 'topup'] as const).map(metric => (
              <span key={metric} className="inline-flex items-center gap-1">
                <span aria-hidden="true">·</span>
                <span>
                  {t(metric === 'spend' ? 'financeSpend' : 'financeTopup')}:{' '}
                  {formatFinanceAmount(report.totals[metric])} USD
                </span>
                <IconButton
                  size="xs"
                  variant="ghost"
                  label={`${t('financeCopyAmount')}: ${t(metric === 'spend' ? 'financeSpend' : 'financeTopup')}`}
                  disabled={report.totals[metric] === null}
                  onClick={() => {
                    void copyText(formatFinanceAmount(report.totals[metric]))
                      .then(ok => {
                        if (ok) push({ tone: 'success', text: t('financeAmountCopied') });
                        else fail();
                      })
                      .catch(fail);
                  }}
                >
                  <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
              </span>
            ))}
          </div>
          {monthly ? (
            <MonthlyFinanceSummary
              report={report}
              today={today}
              initialContext={monthlyContext.current}
              onContextChange={context => {
                monthlyContext.current = context;
              }}
              onDay={day => {
                setReturnMonth(date);
                returnRange.current = selectedRange ?? undefined;
                navigate(day, false);
              }}
            />
          ) : (
            <div className="team-accounts-table finance-daily-table">
              <div className="finance-daily-header">
                {dirty && !monthly && canEdit && (
                  <div className="flex flex-wrap items-center justify-end gap-2 bg-neutral-soft p-2 rounded-lg">
                    <span className="mr-auto text-label text-warning-text">
                      {t('financeUnsaved')} · {Object.keys(drafts).length}
                    </span>
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setDrafts({});
                        setDraftEpoch(e => e + 1);
                      }}
                    >
                      {t('financeCancel')}
                    </Button>
                    <Button
                      size="sm"
                      color="success"
                      loading={savingAll}
                      disabled={pending}
                      onClick={() => requestSave()}
                    >
                      {t('financeSave')}
                    </Button>
                  </div>
                )}
                {movedDraft && (
                  <p role="status" className="m-0 p-2 text-label text-warning-text">
                    {t('financePlacementChangedDrafts')}
                  </p>
                )}
                <div className="team-accounts-columns finance-daily-columns" aria-hidden="true">
                  <span />
                  <span>{t('teamAccountColumnAgent')}</span>
                  <span>{t('financeBalance')} · USD</span>
                  <span>{t('financeTopup')} · USD</span>
                  <span>{t('financeSpend')} · USD</span>
                  <span />
                </div>
              </div>
              <div className="team-accounts-list">
                {report.accounts.map(account => {
                  const columns = report.columns.filter(
                    c =>
                      c.accountId === account.id &&
                      (!query.trim() ||
                        `${c.accountName} ${c.agentId}`
                          .toLocaleLowerCase()
                          .includes(query.trim().toLocaleLowerCase())) &&
                      finance.snapshot!.placements.some(
                        p =>
                          p.agentRowId === c.agentRowId &&
                          p.accountId === c.accountId &&
                          p.startsOn <= date &&
                          (p.endsOn === null || date < p.endsOn)
                      )
                  );
                  return columns.length ? (
                    <FinanceAccountGroup
                      key={account.id}
                      id={account.id}
                      name={account.name}
                      count={columns.length}
                      agents={agents.filter(agent =>
                        columns.some(column => column.agentRowId === agent.id)
                      )}
                    >
                      {columns.map(c => (
                        <div
                          key={`${teamId}/${date}/${c.agentRowId}/${draftEpoch}`}
                          className="team-agent-row finance-daily-row"
                        >
                          <span className="team-agent-rail" aria-hidden="true" />
                          <div className="team-agent-id">
                            <span className="team-agent-tag">
                              <span className="team-agent-tag-text">
                                <AgentIdentity accountName={c.accountName} agentId={c.agentId} />
                              </span>
                            </span>
                            <IconButton
                              size="xs"
                              className="team-agent-copy"
                              label={`${t('teamAgentCopyId')}: ${c.agentId}`}
                              onClick={() => {
                                void copyText(c.agentId).catch(fail);
                              }}
                            >
                              <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                            </IconButton>
                            <AgentLabels
                              labels={agents.find(a => a.id === c.agentRowId)?.labels ?? []}
                              available={labels}
                              canEdit={canEdit && Boolean(onToggleLabel)}
                              agentLabel={c.agentId}
                              onToggle={(label, next) => {
                                const agent = agents.find(a => a.id === c.agentRowId);
                                if (agent && onToggleLabel)
                                  void onToggleLabel(agent, label.id, next).catch(fail);
                              }}
                            />
                          </div>
                          <div className="finance-daily-fields">
                            {FINANCE_METRICS.map(metric => (
                              <DailyFinanceField
                                placementId={
                                  finance.snapshot!.placements.find(
                                    p =>
                                      p.agentRowId === c.agentRowId &&
                                      p.accountId === c.accountId &&
                                      p.startsOn <= date &&
                                      (p.endsOn === null || date < p.endsOn)
                                  )?.id
                                }
                                draftKey={`${c.agentRowId}/${metric}`}
                                contextLabel={`${c.agentId} · ${date}`}
                                onStateChange={onStateChange}
                                onRegisterSave={onRegisterSave}
                                key={metric}
                                metric={metric}
                                compact
                                disabled={pending}
                                canEdit={canEdit && date <= today}
                                field={finance.snapshot!.fields.find(
                                  f =>
                                    f.agentRowId === c.agentRowId &&
                                    f.date === date &&
                                    f.metric === metric
                                )}
                                save={async (value, version, request, placement) => {
                                  try {
                                    const result = await teamFinanceApi.set(
                                      teamId,
                                      c.agentRowId,
                                      date,
                                      metric,
                                      value,
                                      version,
                                      timezone,
                                      request,
                                      placement!
                                    );
                                    const undoRequest = crypto.randomUUID();
                                    if (result.undoReference)
                                      push({
                                        tone: 'info',
                                        text: t('financeCleared'),
                                        action: {
                                          label: t('financeUndo'),
                                          run: () => {
                                            void teamFinanceApi
                                              .undo(teamId, result.undoReference!, undoRequest)
                                              .then(finance.refresh)
                                              .catch(fail);
                                          }
                                        }
                                      });
                                  } finally {
                                    finance.refresh();
                                  }
                                }}
                              />
                            ))}
                          </div>
                          <div className="team-agent-actions finance-daily-actions">
                            <IconButton
                              label={`${t('financeHistory')} · ${c.agentId}`}
                              onClick={() => setHistory(c.agentRowId)}
                            >
                              <History size={ICON_SIZE} strokeWidth={ICON_STROKE} />
                            </IconButton>
                            {canEdit && (
                              <FinanceActions
                                label={t('financeAgentActions', { agent: c.agentId })}
                                disabled={dirty}
                                items={[
                                  ...(date === today
                                    ? [
                                        {
                                          id: 'move',
                                          label: t('financeMove'),
                                          onSelect: () => setMoving(c.agentRowId)
                                        }
                                      ]
                                    : []),
                                  {
                                    id: 'legacy',
                                    label: t('financeLegacy'),
                                    onSelect: () => setLegacy(c.agentRowId)
                                  }
                                ]}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </FinanceAccountGroup>
                  ) : null;
                })}
              </div>
            </div>
          )}
          {!report.columns.length && <p>{t('financeEmpty')}</p>}
        </>
      )}
      {moving && finance.snapshot && (
        <MoveAgentDialog
          snapshot={finance.snapshot}
          agent={moving}
          today={today}
          timezone={timezone}
          onClose={() => setMoving(null)}
          onMoved={finance.refresh}
        />
      )}
      {history && (
        <FinanceHistoryDrawer
          key={`${teamId}/${history}`}
          teamId={teamId}
          agent={history}
          accountName={
            finance.snapshot?.accounts.find(
              a => a.id === agents.find(a => a.id === history)?.accountId
            )?.name ??
            report?.columns.find(c => c.agentRowId === history)?.accountName ??
            ''
          }
          agentId={finance.snapshot?.agents.find(a => a.id === history)?.agentId ?? ''}
          onClose={() => setHistory(null)}
          onReviewLegacy={canEdit ? () => setLegacy(history) : undefined}
        />
      )}
      {legacy && (
        <LegacyFinanceReview
          teamId={teamId}
          agent={legacy}
          today={today}
          timezone={timezone}
          onClose={() => setLegacy(null)}
          onImported={finance.refresh}
        />
      )}
      {clear && (
        <ConfirmDialog
          title={t(clear.metric === 'balance' ? 'financeClearBalance' : 'financeClearTopup')}
          body={`${t('financeClearSummary', { date: clear.date, count: clear.fields.length })} ${t('financeClearBody')}`}
          confirmLabel={t(clear.metric === 'balance' ? 'financeClearBalance' : 'financeClearTopup')}
          cancelLabel={t('financeCancel')}
          busy={clearing}
          onCancel={() => {
            if (!clearing) setClear(null);
          }}
          onConfirm={() => {
            if (clearing) return;
            setClearing(true);
            void teamFinanceApi
              .clear(teamId, clear.date, clear.metric, clear.fields, clear.timezone, clear.request)
              .then(result => {
                setClear(null);
                const undoRequest = crypto.randomUUID();
                if (result.undoReference)
                  push({
                    tone: 'info',
                    text: t('financeCleared'),
                    action: {
                      label: t('financeUndo'),
                      run: () => {
                        void teamFinanceApi
                          .undo(teamId, result.undoReference!, undoRequest)
                          .then(finance.refresh)
                          .catch(fail);
                      }
                    }
                  });
              })
              .catch(fail)
              .finally(() => {
                setClearing(false);
                finance.refresh();
              });
          }}
        />
      )}
      {(navigation || routeNavigation) && (
        <Modal
          title={t('financeTitle')}
          busy={pending}
          onClose={() => {
            if (!pending) {
              setNavigation(null);
              setRouteNavigation(null);
            }
          }}
          footer={
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  setNavigation(null);
                  setRouteNavigation(null);
                }}
              >
                {t('financeStay')}
              </Button>
              <Button disabled={pending} color="error" variant="ghost" onClick={finishNavigation}>
                {t('financeDiscardConfirm')}
              </Button>
              <Button
                color="success"
                loading={savingAll}
                disabled={pending}
                onClick={() => requestSave(true)}
              >
                {t('financeSaveAll')}
              </Button>
            </>
          }
        >
          <p>{t('financeDraftNavigation')}</p>
        </Modal>
      )}
      {confirmSave && (
        <ConfirmDialog
          title={t('financeSave')}
          body={t('financeClearBody')}
          confirmLabel={t('financeSave')}
          cancelLabel={t('financeCancel')}
          busy={pending}
          onCancel={() => setConfirmSave(null)}
          onConfirm={() => {
            const next = confirmSave.continueNavigation;
            setConfirmSave(null);
            void saveAll(next);
          }}
        />
      )}
    </section>
  );
}
