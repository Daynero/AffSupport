import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent
} from 'react';
import { Copy } from 'lucide-react';
import {
  ACCOUNT_ANALYTICS_CODES,
  buildFinanceReport,
  buildFinanceTopupCopy,
  financeMoney,
  parseFinanceMoney,
  type AccountAnalyticsCode,
  type FinanceMetric,
  type FinanceSnapshot
} from '@video-compressor/shared';
import {
  Button,
  ConfirmDialog,
  ErrorState,
  FormField,
  IconButton,
  Input,
  LoadingState,
  Modal
} from '../../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { useToasts } from '../../../components/toast';
import { teamFinanceApi } from '../../../api/team-finance';
import { copyText } from '../../../two-factor/clipboard';
import { BEFORE_NAVIGATION_EVENT, navigateTo } from '../../../lib/navigation';
import { teamErrorMessageFor } from '../../errors';
import { useAgentFinance } from './useAgentFinance';
import { useFinancePeriod } from './useFinancePeriod';
import { financeDraftKey, useFinanceDrafts } from './useFinanceDrafts';
import { financeDecimalComma, formatFinanceAmount } from './formatFinanceAmount';
import { FinanceToolbar } from './FinanceToolbar';
import { FinanceHistoryDrawer } from './FinanceHistoryDrawer';
import { LegacyFinanceReview } from './LegacyFinanceReview';
import { MoveAgentDialog } from './MoveAgentDialog';
import { MonthlyFinanceSummary, type MonthlyFinanceContext } from './MonthlyFinanceSummary';
import { FinanceActions } from './FinanceActions';
import { accountFlowId, emitAccountSignal, type AccountSignal } from '../analytics';
import { retainedFinanceFailure } from './useRetainedFinanceDiagnostics';

export function previousFinanceDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
function monthRange(date: string): [string, string] {
  const first = `${date.slice(0, 7)}-01`;
  const end = new Date(`${first}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return [first, end.toISOString().slice(0, 10)];
}
export interface FinanceSaveSummary {
  attempted: number;
  accepted: number;
  failed: number;
  unknown: number;
  firstFailureCode?: AccountAnalyticsCode;
}
export interface FinanceSaveContext {
  flowId?: string;
  onSummary?: (summary: Readonly<FinanceSaveSummary>) => void;
}
type FinanceContext = ReturnType<typeof useFinanceController>;
const Context = createContext<FinanceContext | null>(null);
export function useUnifiedFinance() {
  const context = useContext(Context);
  if (!context) throw new Error('UnifiedFinanceProvider is missing');
  return context;
}
function useFinanceController({
  teamId,
  userId = 'current',
  canEdit,
  revision,
  enabled = true
}: UnifiedFinanceProps) {
  const { t } = useI18n();
  const { push } = useToasts();
  const drafts = useFinanceDrafts();
  const dirty = drafts.records.size > 0;
  const [agentLabels, setAgentLabels] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [saving, setSaving] = useState(false);
  const savingLock = useRef(false);
  const scopeLifetime = useRef({ active: true, generation: 0, canEdit });
  scopeLifetime.current.canEdit = canEdit;
  const captureScope = useCallback(() => scopeLifetime.current.generation, []);
  const isScopeCurrent = useCallback(
    (generation?: number) =>
      scopeLifetime.current.active &&
      (generation === undefined || generation === scopeLifetime.current.generation),
    []
  );
  useLayoutEffect(() => {
    const lifetime = scopeLifetime.current;
    lifetime.active = true;
    lifetime.generation += 1;
    savingLock.current = false;
    setSaving(false);
    dateIntent.current += 1;
    setSwitchingDate(false);
    // A permission change can interrupt an unresolved request without unmounting.
    // Preserve its idempotency key, and never claim the server rolled it back.
    for (const draft of drafts.records.values())
      if (draft.status === 'pending') drafts.update(draft.key, { ...draft, status: 'unknown' });
    return () => {
      lifetime.active = false;
      lifetime.generation += 1;
    };
  }, [teamId, userId, enabled, canEdit, drafts.records, drafts.update]);
  const [frozenAgents, setFrozenAgents] = useState<readonly string[]>([]);
  const [history, setHistory] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<string | null>(null);
  const [correction, setCorrection] = useState<{ agent: string; date: string } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [reportRange, setReportRange] = useState<[string, string] | null>(null);
  const [periodDetails, setPeriodDetails] = useState(false);
  const [periodDetailFlow, setPeriodDetailFlow] = useState<string | null>(null);
  const [returnReport, setReturnReport] = useState<{
    range: [string, string];
    date: string;
    ranged: boolean;
  } | null>(null);
  const periodDetailContext = useRef<{ key: string; context: MonthlyFinanceContext | undefined }>({
    key: '',
    context: undefined
  });
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [copyIntent, setCopyIntent] = useState<'account' | 'label' | null>(null);
  const [route, setRoute] = useState<{ path: string; replace: boolean; animate: boolean } | null>(
    null
  );
  const [clearing, setClearing] = useState<'balance' | 'topup' | null>(null);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const allowRoute = useRef(false);
  const retainedAccepted = useRef<
    {
      flowId: string;
      operation: AccountSignal['operation'];
      fields: readonly import('@video-compressor/shared').FinanceField[];
    }[]
  >([]);
  const financeAttempts = useRef(new Map<string, string>());
  const accepted = useRef<
    {
      flowId: string;
      attemptId: string;
      day: AccountSignal['day'];
      agent: string;
      date: string;
      metric: FinanceMetric;
      version: string;
    }[]
  >([]);
  const [switchingDate, setSwitchingDate] = useState(false);
  const dateIntent = useRef(0);
  const periodView = useRef<{
    date: string;
    top: number;
    left: number;
    pageTop: number;
    pageLeft: number;
    agent: string | null;
    offset: number;
    flowId: string;
  } | null>(null);
  const period = useFinancePeriod(dirty || saving);
  const yesterday = previousFinanceDay(period.date);
  const finance = useAgentFinance(
    teamId,
    period.date,
    period.date,
    period.timezone,
    revision,
    enabled,
    true,
    `${userId}/${canEdit}`
  );
  const reports = useAgentFinance(
    teamId,
    reportRange?.[0] ?? period.date,
    reportRange?.[1] ?? period.date,
    period.timezone,
    revision,
    enabled && reportRange !== null,
    true,
    `${userId}/${canEdit}`
  );
  const correctionFinance = useAgentFinance(
    teamId,
    correction?.date ?? period.date,
    correction?.date ?? period.date,
    period.timezone,
    revision,
    enabled && correction !== null,
    true,
    `${userId}/${canEdit}`
  );
  const snapshot = finance.snapshot;
  const pending =
    switchingDate || saving || [...drafts.records.values()].some(d => d.status === 'pending');
  const setDate = useCallback(
    async (date: string) => {
      if (date === period.date) {
        dateIntent.current += 1;
        setSwitchingDate(false);
        return;
      }
      const intent = ++dateIntent.current;
      const generation = captureScope();
      const pageTop = window.scrollY;
      const pageLeft = window.scrollX;
      const space = document.querySelector<HTMLElement>('.team-account-space.is-unified');
      if (space)
        space.style.minHeight = `${Math.max(
          space.getBoundingClientRect().height,
          Number.parseFloat(space.style.minHeight) || 0
        )}px`;
      const flowId = accountFlowId();
      emitAccountSignal('retained_action', 'requested', {
        flowId,
        operation: 'financeHistory',
        entity: 'workspace'
      });
      setSwitchingDate(true);
      try {
        const prepared = await finance.preparePeriod(date, date);
        if (intent !== dateIntent.current || !isScopeCurrent(generation)) {
          emitAccountSignal('retained_action', 'terminal', {
            flowId,
            operation: 'financeHistory',
            outcome: 'cancelled',
            result: 'cancelled'
          });
          return;
        }
        if (prepared && finance.presentPrepared(prepared)) {
          const table = document.querySelector<HTMLElement>(
            '.team-account-space.is-unified .team-accounts-table'
          );
          const top = table?.getBoundingClientRect().top ?? 0;
          // A shorter historical day must not clamp the scroll position before
          // we restore the visible account. Keep the canvas, not empty rows.
          const list = table?.querySelector<HTMLElement>('.team-accounts-list');
          if (list)
            list.style.minHeight = `${Math.max(
              list.getBoundingClientRect().height,
              Number.parseFloat(list.style.minHeight) || 0
            )}px`;
          const heading =
            table?.querySelector('.team-accounts-columns')?.getBoundingClientRect().height ?? 0;
          const anchor = [
            ...(table?.querySelectorAll<HTMLElement>('[data-agent-row-id]') ?? [])
          ].find(row => row.getBoundingClientRect().bottom > top + heading);
          periodView.current = {
            date,
            top: table?.scrollTop ?? 0,
            left: table?.scrollLeft ?? 0,
            pageTop,
            pageLeft,
            agent: anchor?.dataset.agentRowId ?? null,
            offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
            flowId
          };
          emitAccountSignal('retained_action', 'accepted', {
            flowId,
            operation: 'financeHistory',
            outcome: 'success'
          });
          period.setDate(date);
        } else
          emitAccountSignal('retained_action', 'terminal', {
            flowId,
            operation: 'financeHistory',
            outcome: 'cancelled',
            result: 'cancelled'
          });
      } catch (cause) {
        emitAccountSignal('retained_action', 'terminal', {
          flowId,
          operation: 'financeHistory',
          ...retainedFinanceFailure(cause)
        });
        if (intent === dateIntent.current && isScopeCurrent(generation))
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
      } finally {
        if (intent === dateIntent.current && isScopeCurrent(generation)) setSwitchingDate(false);
      }
    },
    [
      period.date,
      period.setDate,
      finance.preparePeriod,
      finance.presentPrepared,
      captureScope,
      isScopeCurrent,
      push,
      t
    ]
  );
  useLayoutEffect(() => {
    return () => {
      document
        .querySelector<HTMLElement>('.team-account-space.is-unified .team-accounts-list')
        ?.style.removeProperty('min-height');
      document
        .querySelector<HTMLElement>('.team-account-space.is-unified')
        ?.style.removeProperty('min-height');
    };
  }, [teamId, userId, enabled]);
  useLayoutEffect(() => {
    const view = periodView.current;
    if (!view || view.date !== period.date || snapshot?.from !== period.date) return;
    const table = document.querySelector<HTMLElement>(
      '.team-account-space.is-unified .team-accounts-table'
    );
    if (!table?.isConnected) return;
    const anchor = [...table.querySelectorAll<HTMLElement>('[data-agent-row-id]')].find(
      row => row.dataset.agentRowId === view.agent
    );
    table.scrollLeft = view.left;
    if (anchor)
      table.scrollTop +=
        anchor.getBoundingClientRect().top - table.getBoundingClientRect().top - view.offset;
    else table.scrollTop = view.top;
    if (window.scrollX !== view.pageLeft || window.scrollY !== view.pageTop)
      window.scrollTo(view.pageLeft, view.pageTop);
    periodView.current = null;
    emitAccountSignal('retained_action', 'applied', {
      flowId: view.flowId,
      operation: 'financeHistory',
      outcome: 'success',
      result: 'complete'
    });
  }, [period.date, snapshot]);
  const fail = useCallback(
    (cause: unknown) => {
      if (isScopeCurrent()) push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    },
    [push, t, isScopeCurrent]
  );
  const retainFinanceReceipt = (
    flowId: string,
    operation: AccountSignal['operation'],
    fields: readonly import('@video-compressor/shared').FinanceField[],
    announce = true
  ) => {
    if (!isScopeCurrent()) return;
    if (announce) {
      emitAccountSignal('retained_action', 'accepted', { flowId, operation, outcome: 'success' });
      emitAccountSignal('retained_action', 'terminal', {
        flowId,
        operation,
        outcome: 'success',
        result: fields.length ? 'partial' : 'noop'
      });
    }
    finance.applyFields(fields);
    correctionFinance.applyFields(fields);
    if (fields.length) retainedAccepted.current.push({ flowId, operation, fields });
  };
  const offerUndo = (
    reference: string,
    request: string,
    intent: 'normal' | 'historical_correction' = 'normal'
  ) => {
    const scope = captureScope();
    if (!isScopeCurrent(scope)) return;
    push({
      tone: 'info',
      text: t('financeCleared'),
      action: {
        label: t('financeUndo'),
        run: () => {
          if (!isScopeCurrent(scope) || !scopeLifetime.current.canEdit) return;
          const flowId = accountFlowId();
          emitAccountSignal('retained_action', 'requested', { flowId, operation: 'financeUndo' });
          void teamFinanceApi
            .undo(teamId, reference, request, intent)
            .then(result => {
              if (!isScopeCurrent(scope)) return;
              retainFinanceReceipt(flowId, 'financeUndo', result.fields);
              finance.refresh();
            })
            .catch(cause => {
              if (!isScopeCurrent(scope)) return;
              emitAccountSignal('retained_action', 'terminal', {
                flowId,
                operation: 'financeUndo',
                ...retainedFinanceFailure(cause)
              });
              fail(cause);
            });
        }
      }
    });
  };
  const saveSubset = async (agents?: readonly string[], context: FinanceSaveContext = {}) => {
    const summary: FinanceSaveSummary = { attempted: 0, accepted: 0, failed: 0, unknown: 0 };
    const scope = captureScope();
    const failure = (code: AccountAnalyticsCode) => {
      summary.firstFailureCode ??= code;
    };
    try {
      if (!isScopeCurrent(scope)) {
        failure('SOURCE_CHANGED');
        return false;
      }
      if (!scopeLifetime.current.canEdit) {
        failure('PERMISSION_DENIED');
        return false;
      }
      if (savingLock.current) {
        failure('ACCOUNT_RESULT_UNCERTAIN');
        return false;
      }
      const subset = drafts.getAffectedDrafts(agents);
      summary.attempted = subset.length;
      if (!drafts.validate(agents)) {
        for (const d of subset)
          if (parseFinanceMoney(d.raw) === undefined) {
            summary.failed += 1;
            drafts.update(d.key, { ...d, status: 'failed', error: 'invalid' });
          }
        failure('INVALID_INPUT');
        return false;
      }
      // Keep diagnostic identities only for current drafts. Same-request replay
      // keeps its child attempt ID; financial request IDs never enter telemetry.
      const liveRequests = new Set(drafts.getAffectedDrafts().map(d => d.requestId));
      for (const request of financeAttempts.current.keys())
        if (!liveRequests.has(request)) financeAttempts.current.delete(request);
      for (const d of subset)
        if (d.status !== 'pending')
          drafts.update(d.key, { ...d, status: 'pending', error: undefined });
      savingLock.current = true;
      setSaving(true);
      let success = true;
      try {
        for (const d of subset) {
          if (!isScopeCurrent(scope) || !scopeLifetime.current.canEdit) {
            failure('SOURCE_CHANGED');
            return false;
          }
          if (d.status === 'pending') {
            success = false;
            summary.unknown += 1;
            failure('ACCOUNT_RESULT_UNCERTAIN');
            continue;
          }
          const flowId = context.flowId ?? accountFlowId();
          let attemptId = financeAttempts.current.get(d.requestId);
          if (!attemptId) {
            attemptId = accountFlowId();
            financeAttempts.current.set(d.requestId, attemptId);
          }
          const day: AccountSignal['day'] =
            d.date === period.today
              ? 'today'
              : d.date === previousFinanceDay(period.today)
                ? 'previous'
                : 'historical';
          const signal = { flowId, attemptId, entity: 'rk' as const, day };
          emitAccountSignal('finance_edit', 'requested', signal);
          drafts.update(d.key, { ...d, status: 'pending', error: undefined });
          try {
            const cents = parseFinanceMoney(d.raw);
            const result = await teamFinanceApi.set(
              teamId,
              d.agentRowId,
              d.date,
              d.metric,
              cents === null ? null : financeMoney(cents!),
              d.baseVersion,
              d.timezone,
              d.requestId,
              d.placementId,
              d.intent
            );
            if (!isScopeCurrent(scope)) {
              summary.unknown += 1;
              failure('SOURCE_CHANGED');
              return false;
            }
            summary.accepted += 1;
            emitAccountSignal('finance_edit', 'accepted', {
              ...signal,
              result: 'complete',
              outcome: 'success'
            });
            finance.applyFields(result.fields);
            correctionFinance.applyFields(result.fields);
            const canonical = result.fields.find(
              field =>
                field.agentRowId === d.agentRowId &&
                field.date === d.date &&
                field.metric === d.metric
            );
            if (canonical)
              accepted.current.push({
                flowId,
                attemptId,
                day,
                agent: d.agentRowId,
                date: d.date,
                metric: d.metric,
                version: canonical.version
              });
            if (drafts.records.get(d.key)?.generation === d.generation) {
              drafts.update(d.key, null);
              finance.refresh();
            }
            if (result.undoReference)
              offerUndo(result.undoReference, crypto.randomUUID(), d.intent);
          } catch (cause) {
            if (!isScopeCurrent(scope)) {
              summary.unknown += 1;
              failure('SOURCE_CHANGED');
              return false;
            }
            success = false;
            const diagnosed = retainedFinanceFailure(cause);
            const code = ACCOUNT_ANALYTICS_CODES.find(code => code === diagnosed.code) ?? 'UNKNOWN';
            if (diagnosed.result === 'unknown') summary.unknown += 1;
            else summary.failed += 1;
            failure(code);
            emitAccountSignal('finance_edit', 'terminal', { ...signal, ...diagnosed, code });
            drafts.update(d.key, {
              ...d,
              status: diagnosed.result === 'unknown' ? 'unknown' : 'failed',
              error: cause instanceof Error ? cause.message : 'FINANCE_ERROR'
            });
          }
        }
      } finally {
        if (isScopeCurrent(scope)) {
          savingLock.current = false;
          setSaving(false);
          finance.refresh();
        }
      }
      if (drafts.getAffectedDrafts(agents).length) {
        success = false;
        failure('SOURCE_CHANGED');
      }
      return success;
    } finally {
      // A per-call result cannot accidentally describe another save/retry. The
      // consumer must still fence its own lifecycle operation before UI work.
      try {
        context.onSummary?.({ ...summary });
      } catch {
        /* Diagnostics never changes a saved result. */
      }
    }
  };
  const copyTopups = async (grouping: 'account' | 'label') => {
    const scope = captureScope();
    if (!isScopeCurrent(scope) || !enabled || pending) return;
    if (drafts.getAffectedDrafts().some(d => d.date === period.date && d.metric === 'topup')) {
      setCopyIntent(grouping);
      return;
    }
    const flowId = accountFlowId();
    emitAccountSignal('topup_copy', 'requested', { flowId });
    try {
      // Fresh complete report; collapsed/filtered rows are intentionally irrelevant.
      const confirmed = await teamFinanceApi.snapshot(
        teamId,
        period.date,
        period.date,
        period.timezone,
        true
      );
      if (!isScopeCurrent(scope)) return;
      const contents = buildFinanceTopupCopy(
        confirmed,
        grouping,
        agentLabels,
        t('teamAgentLabelsUntagged'),
        period.date
      );
      if (!contents.count) {
        push({ tone: 'info', text: t('financeCopyEmpty', { date: period.date }) });
        return;
      }
      emitAccountSignal('topup_copy', 'clipboard_requested', { flowId, count: contents.count });
      const copied = await copyText(contents.text);
      if (!isScopeCurrent(scope)) return;
      if (copied) {
        emitAccountSignal('topup_copy', 'clipboard_confirmed', {
          flowId,
          count: contents.count,
          result: 'complete',
          outcome: 'success'
        });
        push({ tone: 'success', text: t('teamAccountsCopied', { count: contents.count }) });
      } else {
        emitAccountSignal('topup_copy', 'terminal', {
          flowId,
          code: 'CLIPBOARD_DENIED',
          result: 'denied',
          outcome: 'failure'
        });
        setManualCopy(contents.text);
      }
    } catch (cause) {
      if (isScopeCurrent(scope)) fail(cause);
    }
  };
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (drafts.records.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const beforeRoute = (e: Event) => {
      if (!drafts.records.size || allowRoute.current || !(e instanceof CustomEvent)) return;
      e.preventDefault();
      setRoute(e.detail);
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener(BEFORE_NAVIGATION_EVENT, beforeRoute);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener(BEFORE_NAVIGATION_EVENT, beforeRoute);
    };
  }, [drafts.records]);
  const navigateRoute = () => {
    if (!isScopeCurrent() || !route) return;
    allowRoute.current = true;
    navigateTo(route.path, route.replace, route.animate);
  };
  useEffect(() => {
    accepted.current = accepted.current
      .filter(item => {
        const node = [
          ...document.querySelectorAll<HTMLElement>('[data-finance-field-version]')
        ].find(
          element =>
            element.dataset.financeField === `${item.agent}/${item.date}/${item.metric}` &&
            element.dataset.financeFieldVersion === item.version
        );
        if (!node) return true;
        emitAccountSignal('finance_edit', 'applied', {
          flowId: item.flowId,
          attemptId: item.attemptId,
          day: item.day,
          result: 'complete',
          outcome: 'success'
        });
        return false;
      })
      .slice(-100);
  });
  const proofScheduled = useRef(false);
  const proveRetainedFinanceReceipts = useCallback(() => {
    if (!isScopeCurrent() || !retainedAccepted.current.length) return;
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-finance-field-version]')];
    const versions = new Map(
      nodes.map(element => [element.dataset.financeField, element.dataset.financeFieldVersion])
    );
    retainedAccepted.current = retainedAccepted.current
      .filter(item => {
        const visible = item.fields.every(
          field =>
            versions.get(`${field.agentRowId}/${field.date}/${field.metric}`) === field.version
        );
        if (!visible) return true;
        emitAccountSignal('retained_action', 'applied', {
          flowId: item.flowId,
          operation: item.operation,
          outcome: 'success',
          result: 'complete'
        });
        return false;
      })
      .slice(-100);
  }, [isScopeCurrent]);
  const scheduleRetainedFinanceProof = useCallback(() => {
    if (proofScheduled.current || !retainedAccepted.current.length) return;
    proofScheduled.current = true;
    queueMicrotask(() => {
      proofScheduled.current = false;
      proveRetainedFinanceReceipts();
    });
  }, [proveRetainedFinanceReceipts]);
  useEffect(proveRetainedFinanceReceipts);
  const dailyReport = useMemo(
    () =>
      snapshot
        ? buildFinanceReport({
            ...snapshot,
            from: period.date,
            to: period.date,
            fields: snapshot.fields.filter(f => f.date === period.date)
          })
        : null,
    [snapshot, period.date]
  );
  return {
    ...period,
    setDate,
    switchingDate,
    yesterday,
    teamId,
    userId,
    canEdit,
    enabled,
    snapshot,
    loading: finance.loading,
    error: finance.error,
    refresh: finance.refresh,
    report: reportRange
      ? reports.snapshot &&
        reports.snapshot.from === reportRange[0] &&
        reports.snapshot.to === reportRange[1]
        ? buildFinanceReport(reports.snapshot)
        : null
      : dailyReport,
    dirty,
    pending,
    drafts,
    saveSubset,
    retainFinanceReceipt,
    scheduleRetainedFinanceProof,
    captureScope,
    isScopeCurrent,
    getAffectedDrafts: drafts.getAffectedDrafts,
    discardSubset: drafts.discardSubset,
    frozenAgents,
    setFrozenAgents,
    setAgentLabels,
    history,
    setHistory,
    legacy,
    setLegacy,
    moving,
    setMoving,
    correction,
    setCorrection,
    correctionFinance,
    reportRange,
    setReportRange,
    periodDetails,
    setPeriodDetails,
    periodDetailFlow,
    setPeriodDetailFlow,
    periodDetailContext,
    returnReport,
    setReturnReport,
    reports,
    offerUndo,
    copyTopups,
    copyIntent,
    setCopyIntent,
    manualCopy,
    setManualCopy,
    route,
    setRoute,
    navigateRoute,
    clearing,
    setClearing,
    clearConfirmation,
    setClearConfirmation,
    fail
  };
}
export interface UnifiedFinanceProps {
  teamId: string;
  userId?: string;
  canEdit: boolean;
  revision: number;
  enabled?: boolean;
  children?: ReactNode;
}
export function UnifiedFinanceProvider(props: UnifiedFinanceProps) {
  // Context remount clears another identity's private draft state.
  return <FinanceSession key={`${props.userId ?? 'current'}/${props.teamId}`} {...props} />;
}
function FinanceSession(props: UnifiedFinanceProps) {
  const controller = useFinanceController(props);
  return (
    <Context.Provider value={controller}>
      {props.children}
      <UnifiedFinanceDialogs />
    </Context.Provider>
  );
}

export function UnifiedAgentFinanceFields({
  agentRowId,
  accountId,
  contextLabel,
  historical = false
}: {
  agentRowId: string;
  accountId?: string;
  contextLabel?: string;
  historical?: boolean;
}) {
  const finance = useUnifiedFinance();
  const { t } = useI18n();
  if (!finance.enabled) return null;
  return (
    <div
      className="finance-daily-fields unified-agent-finance"
      data-finance-agent={agentRowId}
      data-finance-social={accountId}
    >
      {finance.reportRange ? (
        <UnifiedFinancePeriodCells
          agentRowId={agentRowId}
          accountId={accountId}
          contextLabel={contextLabel}
        />
      ) : (
        (
          [
            ['balance', finance.date, t('financeBalance')],
            ['topup', finance.date, t('financeTopup')],
            [
              'spend',
              finance.date,
              finance.date === finance.today
                ? `${t('financeSpend')} · ${t('financeToday')}`
                : t('financeSpend')
            ]
          ] as readonly (readonly [FinanceMetric, string, string])[]
        ).map(([metric, date, label]) => (
          <UnifiedFinanceCell
            key={metric}
            agentRowId={agentRowId}
            accountId={accountId}
            metric={metric}
            date={date}
            label={label}
            contextLabel={contextLabel}
            historical={historical}
          />
        ))
      )}
    </div>
  );
}
function UnifiedFinancePeriodCells({
  agentRowId,
  accountId,
  contextLabel
}: {
  agentRowId: string;
  accountId?: string;
  contextLabel?: string;
}) {
  const finance = useUnifiedFinance();
  const { t } = useI18n();
  const report = finance.report;
  const range = finance.reportRange!;
  const column = report?.columns.find(
    column => column.agentRowId === agentRowId && (!accountId || column.accountId === accountId)
  );
  const balance = column
    ? (report?.cell(column.accountId, agentRowId, range[1], 'balance') ?? null)
    : null;
  const unavailable = finance.reports.loading || finance.reports.error || !report;
  return (
    <>
      {(['balance', 'topup', 'spend'] as const).map(metric => {
        const label = t(
          metric === 'balance'
            ? 'financeBalance'
            : metric === 'topup'
              ? 'financeTopup'
              : 'financeSpend'
        );
        const value = metric === 'balance' ? balance : (column?.totals[metric] ?? null);
        return (
          <span
            key={metric}
            className="finance-cell text-label tabular-nums"
            aria-label={`${contextLabel ?? agentRowId} · ${label} · ${range[0]} — ${range[1]} · USD`}
          >
            {unavailable ? '…' : formatFinanceAmount(value)}
          </span>
        );
      })}
    </>
  );
}
function UnifiedFinanceCell({
  agentRowId,
  accountId,
  metric,
  date,
  label,
  contextLabel,
  historical,
  snapshotOverride
}: {
  agentRowId: string;
  accountId?: string;
  metric: FinanceMetric;
  date: string;
  label: string;
  contextLabel?: string;
  historical: boolean;
  snapshotOverride?: FinanceSnapshot | null;
}) {
  const f = useUnifiedFinance();
  const { t } = useI18n();
  const snapshot = snapshotOverride === undefined ? f.snapshot : snapshotOverride;
  const field = snapshot?.fields.find(
    v => v.agentRowId === agentRowId && v.date === date && v.metric === metric
  );
  const placement = snapshot?.placements.find(
    p =>
      p.agentRowId === agentRowId &&
      (date !== f.date || !accountId || p.accountId === accountId) &&
      p.startsOn <= date &&
      (!p.endsOn || date < p.endsOn)
  );
  const key = financeDraftKey(f.userId, f.teamId, agentRowId, date, metric);
  const draft = f.drafts.records.get(key);
  const lifecycle = snapshot?.lifecycle;
  const archived = Boolean(
    lifecycle?.agents.find(a => a.id === agentRowId)?.archivedAt ||
    lifecycle?.accounts.find(a => a.id === placement?.accountId)?.archivedAt
  );
  useEffect(() => {
    f.scheduleRetainedFinanceProof();
  }, [f.scheduleRetainedFinanceProof, field?.version, draft?.generation]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && draft?.status !== 'pending') f.drafts.update(key, null);
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (draft && parseFinanceMoney(draft.raw) === undefined) {
      f.drafts.update(key, { ...draft, status: 'failed', error: 'invalid' });
      return;
    }
    const scope = e.currentTarget
      .closest('[data-finance-social]')
      ?.getAttribute('data-finance-social');
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-finance-column]')].filter(
      input =>
        input.dataset.financeColumn === `${date}/${metric}` &&
        input.closest('[data-finance-social]')?.getAttribute('data-finance-social') === scope &&
        !input.disabled
    );
    inputs[inputs.indexOf(e.currentTarget) + (e.shiftKey ? -1 : 1)]?.focus();
  };
  return (
    <div
      className="finance-cell"
      data-finance-field={`${agentRowId}/${date}/${metric}`}
      data-finance-field-version={draft ? undefined : field?.version}
      data-finance-state={draft ? 'dirty' : field?.value != null ? 'saved' : 'empty'}
    >
      <FormField
        label={historical ? <span className="finance-field-label">{label} · USD</span> : undefined}
        error={
          draft?.error
            ? t(
                draft.error === 'invalid'
                  ? 'financeInvalidShort'
                  : draft.error.includes('CONFLICT')
                    ? 'financeConflictShort'
                    : 'financeErrorShort'
              )
            : undefined
        }
      >
        <Input
          aria-label={`${contextLabel ?? agentRowId} · ${date} · ${label} · USD`}
          data-finance-column={`${date}/${metric}`}
          inputMode="decimal"
          value={draft?.raw ?? formatFinanceAmount(field?.value, '')}
          readOnly={!f.canEdit || f.switchingDate}
          disabled={
            !placement ||
            (!historical && archived) ||
            f.frozenAgents.includes(agentRowId) ||
            draft?.status === 'pending' ||
            date > f.today
          }
          invalid={Boolean(draft?.error)}
          width="full"
          onKeyDown={onKeyDown}
          onChange={e => {
            if (!f.canEdit || !placement || (!historical && archived)) return;
            f.drafts.edit(
              {
                key,
                agentRowId,
                date,
                metric,
                currency: 'USD',
                timezone: f.timezone,
                placementId: placement.id,
                intent: historical ? 'historical_correction' : 'normal'
              },
              financeDecimalComma(e.target.value),
              field
            );
          }}
        />
      </FormField>
      {draft?.error?.includes('FINANCE_CONFLICT') && (
        <div className="finance-cell-message text-label text-error-text">
          {t('financeCurrentValue', { value: formatFinanceAmount(field?.value) })}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              f.drafts.update(key, {
                ...draft,
                baseVersion: field?.version ?? '0',
                requestId: crypto.randomUUID(),
                status: 'dirty',
                error: undefined
              });
            }}
          >
            {t('retry')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function UnifiedFinanceToolbar() {
  const f = useUnifiedFinance();
  const { push } = useToasts();
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  if (!f.enabled) return null;
  const range = f.reportRange ?? [f.date, f.date];
  const sourcePending = f.reportRange
    ? f.reports.loading || Boolean(f.reports.error)
    : f.loading || Boolean(f.error);
  const confirmedReport = f.report && !sourcePending && !f.dirty && !f.pending ? f.report : null;
  const openDetails = () => {
    if (!confirmedReport || !f.isScopeCurrent()) return;
    const key = JSON.stringify([range, f.timezone]);
    if (f.periodDetailContext.current.key !== key)
      f.periodDetailContext.current = {
        key,
        context: f.reportRange
          ? undefined
          : { metric: 'spend', view: 'statement', scrollLeft: 0, scrollTop: 0 }
      };
    const flowId = accountFlowId();
    emitAccountSignal('retained_action', 'requested', {
      flowId,
      operation: 'financeHistory',
      entity: 'workspace'
    });
    f.setPeriodDetailFlow(flowId);
    f.setPeriodDetails(true);
  };
  const copyAmount = async (metric: 'spend' | 'topup') => {
    const scope = f.captureScope();
    const value = confirmedReport?.totals[metric];
    if (!f.isScopeCurrent(scope) || value == null) return;
    const flowId = accountFlowId();
    emitAccountSignal('retained_action', 'requested', { flowId, entity: 'workspace' });
    try {
      emitAccountSignal('retained_action', 'clipboard_requested', {
        flowId,
        entity: 'workspace',
        count: 1
      });
      const copied = await copyText(formatFinanceAmount(value));
      if (!f.isScopeCurrent(scope)) return;
      if (!copied) {
        emitAccountSignal('retained_action', 'terminal', {
          flowId,
          code: 'CLIPBOARD_DENIED',
          outcome: 'failure',
          result: 'denied'
        });
        push({ tone: 'error', text: t('financeError') });
        return;
      }
      emitAccountSignal('retained_action', 'clipboard_confirmed', {
        flowId,
        outcome: 'success',
        result: 'complete',
        count: 1
      });
      // The amount is clipboard content only, never a diagnostic property.
      push({ tone: 'success', text: t('financeAmountCopied') });
    } catch (cause) {
      if (!f.isScopeCurrent(scope)) return;
      emitAccountSignal('retained_action', 'terminal', {
        flowId,
        ...retainedFinanceFailure(cause)
      });
      f.fail(cause);
    }
  };
  return (
    <div className="unified-finance-toolbar flex flex-col gap-2">
      <FinanceToolbar
        compact
        mobileActions={[
          {
            id: 'period-details',
            label: t('financePeriodDetails'),
            disabled: !confirmedReport,
            onSelect: openDetails
          },
          ...(f.reportRange
            ? []
            : [
                {
                  id: 'copy-socials',
                  label: t('financeCopyByAccount'),
                  disabled: f.pending || !f.snapshot || Boolean(f.error),
                  onSelect: () => {
                    void f.copyTopups('account');
                  }
                },
                {
                  id: 'copy-labels',
                  label: t('financeCopyByLabel'),
                  disabled: f.pending || !f.snapshot || Boolean(f.error),
                  onSelect: () => {
                    void f.copyTopups('label');
                  }
                }
              ])
        ]}
        date={f.date}
        today={f.today}
        monthly={Boolean(f.reportRange)}
        from={range[0]}
        to={range[1]}
        timezone={f.timezone}
        pending={(f.pending && !f.switchingDate) || f.dirty}
        exporting={exporting}
        canExport={Boolean(f.snapshot) && !f.error}
        navigate={(date, monthly) => {
          if (monthly) {
            f.setDate(date);
            f.setReportRange(monthRange(date));
          } else {
            f.setReportRange(null);
            f.setDate(date);
          }
        }}
        onRange={(from, to) => {
          if (from === to) {
            f.setDate(from);
            f.setReportRange(null);
          } else {
            f.setDate(from);
            f.setReportRange([from, to]);
          }
        }}
        onExport={() => {
          const scope = f.captureScope();
          if (!f.isScopeCurrent(scope)) return;
          const flowId = accountFlowId();
          emitAccountSignal('retained_action', 'requested', { flowId, operation: 'financeExport' });
          setExporting(true);
          void teamFinanceApi
            .export(f.teamId, range[0], range[1], f.timezone)
            .then(() => {
              if (!f.isScopeCurrent(scope)) return;
              emitAccountSignal('retained_action', 'accepted', {
                flowId,
                operation: 'financeExport',
                outcome: 'success'
              });
              // Binary received and browser dispatch returned; OS delivery is unobservable.
              emitAccountSignal('retained_action', 'terminal', {
                flowId,
                operation: 'financeExport',
                outcome: 'success',
                result: 'partial'
              });
            })
            .catch(cause => {
              if (f.isScopeCurrent(scope)) {
                emitAccountSignal('retained_action', 'terminal', {
                  flowId,
                  operation: 'financeExport',
                  ...retainedFinanceFailure(cause)
                });
                f.fail(cause);
              }
            })
            .finally(() => {
              if (f.isScopeCurrent(scope)) setExporting(false);
            });
        }}
      />
      {!f.reportRange && f.returnReport && (
        <Button
          size="sm"
          variant="ghost"
          disabled={f.dirty || f.pending}
          onClick={() => {
            const previous = f.returnReport;
            if (!previous || f.dirty || f.pending || !f.isScopeCurrent()) return;
            f.setDate(previous.date);
            f.setReportRange(previous.ranged ? previous.range : null);
            const flowId = accountFlowId();
            emitAccountSignal('retained_action', 'requested', {
              flowId,
              operation: 'financeHistory',
              entity: 'workspace'
            });
            f.setPeriodDetailFlow(flowId);
            f.setPeriodDetails(true);
          }}
        >
          {t('financeReturnReport')}
        </Button>
      )}
      {f.pendingContext && (
        <p role="status" className="text-label text-ink-muted">
          {t('financeContextChanged')}
        </p>
      )}
      <div className="unified-finance-summary flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="hidden md:inline-flex"
          disabled={!confirmedReport}
          onClick={openDetails}
        >
          {t('financePeriodDetails')}
        </Button>

        {!f.reportRange && (
          <>
            <Button
              data-finance-copy="true"
              size="sm"
              variant="soft"
              disabled={f.pending || !f.snapshot || Boolean(f.error)}
              onClick={() => {
                void f.copyTopups('account');
              }}
              leading={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            >
              {t('financeCopyByAccount')}
            </Button>
            <Button
              data-finance-copy="true"
              size="sm"
              variant="ghost"
              disabled={f.pending || !f.snapshot || Boolean(f.error)}
              className="finance-copy-labels"
              onClick={() => {
                void f.copyTopups('label');
              }}
            >
              {t('financeCopyByLabel')}
            </Button>
          </>
        )}
        {f.canEdit && !f.reportRange && (
          <FinanceActions
            label={t('financePeriodActions')}
            disabled={f.dirty || f.pending || !f.snapshot}
            items={(['balance', 'topup'] as const).map(metric => ({
              id: metric,
              label: t(metric === 'balance' ? 'financeClearBalance' : 'financeClearTopup'),
              onSelect: () => f.setClearing(metric)
            }))}
          />
        )}
        {f.dirty && (
          <>
            <Button
              data-finance-primary="true"
              size="sm"
              color="success"
              disabled={f.pending}
              onClick={() => {
                if (
                  f
                    .getAffectedDrafts()
                    .some(
                      d =>
                        parseFinanceMoney(d.raw) === null &&
                        f.snapshot?.fields.some(
                          v =>
                            v.agentRowId === d.agentRowId &&
                            v.date === d.date &&
                            v.metric === d.metric &&
                            v.value !== null
                        )
                    )
                )
                  f.setClearConfirmation(true);
                else void f.saveSubset();
              }}
            >
              {t('financeSave')}
            </Button>
            <Button
              data-finance-primary="true"
              size="sm"
              variant="ghost"
              disabled={f.pending}
              onClick={() => f.discardSubset()}
            >
              {t('financeCancel')}
            </Button>
          </>
        )}
        {f.report && (
          <p className="flex flex-wrap items-center gap-2 text-label text-ink-muted">
            {(['spend', 'topup'] as const).map(metric => (
              <span key={metric} className="inline-flex items-center gap-1">
                <span>
                  {t(metric === 'spend' ? 'financeSpend' : 'financeTopup')}:{' '}
                  {formatFinanceAmount(f.report!.totals[metric])} USD
                </span>
                <IconButton
                  size="xs"
                  variant="ghost"
                  label={`${t('financeCopyAmount')}: ${t(metric === 'spend' ? 'financeSpend' : 'financeTopup')}`}
                  disabled={!confirmedReport || confirmedReport.totals[metric] === null}
                  onClick={() => {
                    void copyAmount(metric);
                  }}
                >
                  <Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </IconButton>
              </span>
            ))}
          </p>
        )}
      </div>
      {f.loading && !f.snapshot && <LoadingState label={t('financeTitle')} />}
      {f.reportRange && f.reports.loading && !f.reports.snapshot && (
        <LoadingState label={t('financeTitle')} />
      )}
      {f.reportRange && f.reports.error && (
        <ErrorState message={t('financeError')} onRetry={f.reports.refresh} />
      )}
      {f.error && <ErrorState message={t('financeError')} onRetry={f.refresh} />}
    </div>
  );
}

function UnifiedFinanceDialogs() {
  const f = useUnifiedFinance();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBusy(false);
  }, [f.teamId, f.userId, f.canEdit, f.enabled]);
  const clearAttempt = useRef<{
    date: string;
    metric: 'balance' | 'topup';
    fields: { agent: string; expectedVersion: string }[];
    requestId: string;
  } | null>(null);
  const currentAgent = f.snapshot?.agents.find(a => a.id === f.history);
  const accountNameFor = (agent: string) => {
    const placement =
      f.snapshot?.placements.find(p => p.agentRowId === agent && p.endsOn === null) ??
      f.snapshot?.placements.find(p => p.agentRowId === agent);
    return f.snapshot?.accounts.find(account => account.id === placement?.accountId)?.name ?? '';
  };
  const detailsRange = f.reportRange ?? [f.date, f.date];
  const detailsKey = JSON.stringify([detailsRange, f.timezone]);
  const detailsReady =
    Boolean(f.report) &&
    !(f.reportRange ? f.reports.loading || f.reports.error : f.loading || f.error);
  useEffect(() => {
    if (!f.periodDetails || !f.periodDetailFlow || !detailsReady || !f.isScopeCurrent()) return;
    const flowId = f.periodDetailFlow;
    emitAccountSignal('retained_action', 'accepted', {
      flowId,
      operation: 'financeHistory',
      entity: 'workspace',
      outcome: 'success'
    });
    emitAccountSignal('retained_action', 'applied', {
      flowId,
      operation: 'financeHistory',
      entity: 'workspace',
      outcome: 'success',
      result: 'complete'
    });
    f.setPeriodDetailFlow(null);
  }, [f.periodDetails, f.periodDetailFlow, detailsReady, f.isScopeCurrent, f.setPeriodDetailFlow]);
  const correctionAgent = f.snapshot?.agents.find(agent => agent.id === f.correction?.agent);
  const correctionLabel = f.correction
    ? `${accountNameFor(f.correction.agent)} · ${correctionAgent?.agentId ?? t('financeTitle')}`
    : '';
  return (
    <>
      {f.periodDetails && (
        <Modal
          title={`${t('financePeriodDetails')} · ${detailsRange[0]} — ${detailsRange[1]}`}
          size="lg"
          onClose={() => f.setPeriodDetails(false)}
          footer={<Button onClick={() => f.setPeriodDetails(false)}>{t('teamClose')}</Button>}
        >
          {(f.reportRange ? f.reports.error : f.error) ? (
            <ErrorState
              message={t('financeError')}
              onRetry={f.reportRange ? f.reports.refresh : f.refresh}
            />
          ) : !detailsReady ? (
            <LoadingState label={t('financeTitle')} />
          ) : (
            f.report && (
              <div className="min-w-0">
                <MonthlyFinanceSummary
                  report={f.report}
                  today={f.today}
                  initialContext={
                    f.periodDetailContext.current.key === detailsKey
                      ? f.periodDetailContext.current.context
                      : undefined
                  }
                  onContextChange={context => {
                    f.periodDetailContext.current = { key: detailsKey, context };
                  }}
                  onDay={day => {
                    if (f.dirty || f.pending || day > f.today || !f.isScopeCurrent()) return;
                    f.setReturnReport({
                      range: [detailsRange[0], detailsRange[1]],
                      date: f.date,
                      ranged: Boolean(f.reportRange)
                    });
                    f.setPeriodDetails(false);
                    f.setReportRange(null);
                    f.setDate(day);
                  }}
                />
              </div>
            )
          )}
        </Modal>
      )}
      {f.history && (
        <FinanceHistoryDrawer
          teamId={f.teamId}
          agent={f.history}
          agentId={currentAgent?.agentId ?? ''}
          accountName={accountNameFor(f.history)}
          onClose={() => f.setHistory(null)}
          onReviewLegacy={f.canEdit ? () => f.setLegacy(f.history) : undefined}
          onCorrect={f.canEdit ? date => f.setCorrection({ agent: f.history!, date }) : undefined}
        />
      )}
      {f.correction && (
        <Modal
          title={`${t('financeHistory')} · ${correctionLabel} · ${f.correction.date}`}
          onClose={() => f.setCorrection(null)}
          footer={
            <Button
              disabled={f.pending}
              onClick={() => {
                void f.saveSubset([f.correction!.agent]);
              }}
            >
              {t('financeSave')}
            </Button>
          }
        >
          {f.correctionFinance.error && (
            <ErrorState message={t('financeError')} onRetry={f.correctionFinance.refresh} />
          )}
          {(['balance', 'topup', 'spend'] as const).map(metric => (
            <UnifiedFinanceCell
              key={metric}
              agentRowId={f.correction!.agent}
              contextLabel={correctionLabel}
              date={f.correction!.date}
              metric={metric}
              label={t(
                metric === 'balance'
                  ? 'financeBalance'
                  : metric === 'topup'
                    ? 'financeTopup'
                    : 'financeSpend'
              )}
              historical
              snapshotOverride={f.correctionFinance.snapshot}
            />
          ))}
        </Modal>
      )}
      {f.legacy && (
        <LegacyFinanceReview
          teamId={f.teamId}
          agent={f.legacy}
          today={f.today}
          timezone={f.timezone}
          onClose={() => f.setLegacy(null)}
          onImported={(receipt, flowId) => {
            if (!f.isScopeCurrent()) return;
            if (receipt && flowId)
              f.retainFinanceReceipt(flowId, 'financeLegacyImport', receipt.fields, false);
            f.refresh();
          }}
        />
      )}
      {f.moving && f.snapshot && (
        <MoveAgentDialog
          snapshot={f.snapshot}
          agent={f.moving}
          today={f.today}
          timezone={f.timezone}
          onClose={() => f.setMoving(null)}
          onMoved={f.refresh}
        />
      )}
      {f.clearConfirmation && (
        <ConfirmDialog
          title={t('financeSave')}
          body={t('financeClearBody')}
          confirmLabel={t('financeSave')}
          cancelLabel={t('financeCancel')}
          busy={f.pending}
          onCancel={() => f.setClearConfirmation(false)}
          onConfirm={() => {
            f.setClearConfirmation(false);
            void f.saveSubset();
          }}
        />
      )}
      {f.clearing && (
        <ConfirmDialog
          title={t(f.clearing === 'balance' ? 'financeClearBalance' : 'financeClearTopup')}
          body={`${t('financeClearSummary', { date: f.date, count: f.snapshot?.fields.filter(v => v.date === f.date && v.metric === f.clearing && v.value !== null).length ?? 0 })} USD · ${f.timezone}. ${t('financeClearBody')}`}
          confirmLabel={t('financeSave')}
          cancelLabel={t('financeCancel')}
          busy={busy}
          onCancel={() => f.setClearing(null)}
          onConfirm={() => {
            const scope = f.captureScope();
            if (!f.isScopeCurrent(scope) || !f.canEdit || !f.snapshot || !f.clearing || busy)
              return;
            const metric = f.clearing;
            if (
              !clearAttempt.current ||
              clearAttempt.current.date !== f.date ||
              clearAttempt.current.metric !== metric
            )
              clearAttempt.current = {
                date: f.date,
                metric,
                fields: f.snapshot.fields
                  .filter(v => v.date === f.date && v.metric === metric && v.value !== null)
                  .map(v => ({ agent: v.agentRowId, expectedVersion: v.version })),
                requestId: crypto.randomUUID()
              };
            const attempt = clearAttempt.current;
            const flowId = accountFlowId();
            emitAccountSignal('retained_action', 'requested', {
              flowId,
              operation: 'financeClear'
            });
            setBusy(true);
            void teamFinanceApi
              .clear(
                f.teamId,
                attempt.date,
                attempt.metric,
                attempt.fields,
                f.timezone,
                attempt.requestId
              )
              .then(result => {
                if (!f.isScopeCurrent(scope)) return;
                f.retainFinanceReceipt(flowId, 'financeClear', result.fields);
                f.setClearing(null);
                clearAttempt.current = null;
                if (result.undoReference) {
                  const request = crypto.randomUUID();
                  f.offerUndo(result.undoReference, request);
                }
              })
              .catch(cause => {
                if (!f.isScopeCurrent(scope)) return;
                emitAccountSignal('retained_action', 'terminal', {
                  flowId,
                  operation: 'financeClear',
                  ...retainedFinanceFailure(cause)
                });
                if (cause instanceof Error && cause.message.includes('CONFLICT'))
                  clearAttempt.current = null;
                f.fail(cause);
              })
              .finally(() => {
                if (!f.isScopeCurrent(scope)) return;
                setBusy(false);
                f.refresh();
              });
          }}
        />
      )}
      {f.copyIntent && (
        <ConfirmDialog
          title={t('financeCopyByAccount')}
          body={t('financeDraftHelp')}
          confirmLabel={t('financeSaveAll')}
          cancelLabel={t('financeCancel')}
          busy={f.pending}
          onCancel={() => f.setCopyIntent(null)}
          onConfirm={() => {
            const grouping = f.copyIntent!;
            const scope = f.captureScope();
            void f.saveSubset().then(ok => {
              if (ok && f.isScopeCurrent(scope)) {
                f.setCopyIntent(null);
                void f.copyTopups(grouping);
              }
            });
          }}
        />
      )}
      {f.manualCopy && (
        <Modal title={t('financeCopyByAccount')} onClose={() => f.setManualCopy(null)}>
          <textarea
            readOnly
            className="w-full"
            aria-label={t('financeCopyByAccount')}
            value={f.manualCopy}
            onFocus={e => e.currentTarget.select()}
          />
        </Modal>
      )}
      {f.route && (
        <Modal
          title={t('financeTitle')}
          onClose={() => f.setRoute(null)}
          footer={
            <>
              <Button disabled={f.pending} onClick={() => f.setRoute(null)}>
                {t('financeStay')}
              </Button>
              <Button
                disabled={f.pending}
                color="error"
                variant="ghost"
                onClick={() => {
                  f.discardSubset();
                  f.navigateRoute();
                }}
              >
                {t('financeDiscardConfirm')}
              </Button>
              <Button
                disabled={f.pending}
                color="success"
                onClick={() => {
                  void f.saveSubset().then(ok => {
                    if (ok) f.navigateRoute();
                  });
                }}
              >
                {t('financeSaveAll')}
              </Button>
            </>
          }
        >
          <p>{t('financeDraftNavigation')}</p>
        </Modal>
      )}
    </>
  );
}
