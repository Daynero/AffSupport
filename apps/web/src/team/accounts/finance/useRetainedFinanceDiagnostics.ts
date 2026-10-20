import { useCallback, useLayoutEffect, useRef } from 'react';
import { accountFlowId, emitAccountSignal, type AccountSignal } from '../analytics';

export type RetainedFinanceOperation = Extract<
  NonNullable<AccountSignal['operation']>,
  | 'financeClear'
  | 'financeUndo'
  | 'financeLegacyImport'
  | 'financeTransfer'
  | 'financeHistory'
  | 'financeExport'
>;
export interface FinanceDiagnosticAttempt {
  flowId: string;
  generation: number;
  accepted: boolean;
  applied: boolean;
}
export function retainedFinanceFailure(
  cause: unknown
): Pick<AccountSignal, 'code' | 'result' | 'outcome'> {
  const raw =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : cause instanceof Error && /^[A-Z_]+$/u.test(cause.message)
        ? cause.message
        : 'UNKNOWN';
  const aliases: Record<string, string> = {
    FINANCE_CONFLICT: 'VERSION_CONFLICT',
    PLACEMENT_CONFLICT: 'SOURCE_CHANGED',
    FINANCE_UNDO_ALREADY_APPLIED: 'VERSION_CONFLICT',
    FINANCE_AMOUNT_INVALID: 'INVALID_INPUT',
    FUTURE_FINANCE_DATE: 'INVALID_INPUT',
    PARENT_ARCHIVED: 'ACCOUNT_ARCHIVED',
    HISTORICAL_CORRECTION_REQUIRED: 'ACCOUNT_ARCHIVED',
    AUTH_REQUIRED: 'PERMISSION_DENIED',
    NOT_A_MEMBER: 'PERMISSION_DENIED'
  };
  const code = typeof raw === 'string' ? (aliases[raw] ?? raw) : 'UNKNOWN';
  const result =
    code === 'PERMISSION_DENIED' || code === 'ACCOUNT_ARCHIVED'
      ? 'denied'
      : code === 'VERSION_CONFLICT' || code === 'SOURCE_CHANGED'
        ? 'conflict'
        : code === 'INVALID_INPUT' || code === 'NOT_FOUND' || code === 'DATE_BEFORE_AGENT'
          ? 'failed'
          : 'unknown';
  return { code, result, outcome: 'failure' };
}
/** Internal scope keys never enter diagnostic properties. Late results cannot cross identities. */
export function useRetainedFinanceDiagnostics(
  operation: RetainedFinanceOperation,
  scopeKey: string
) {
  const scope = useRef({ active: true, generation: 0 });
  useLayoutEffect(() => {
    scope.current.active = true;
    scope.current.generation += 1;
    return () => {
      scope.current.active = false;
      scope.current.generation += 1;
    };
  }, [scopeKey]);
  const current = useCallback(
    (attempt: FinanceDiagnosticAttempt) =>
      scope.current.active && attempt.generation === scope.current.generation,
    []
  );
  const start = useCallback((): FinanceDiagnosticAttempt => {
    const attempt = {
      flowId: accountFlowId(),
      generation: scope.current.generation,
      accepted: false,
      applied: false
    };
    emitAccountSignal('retained_action', 'requested', { flowId: attempt.flowId, operation });
    return attempt;
  }, [operation]);
  const accept = useCallback(
    (attempt: FinanceDiagnosticAttempt) => {
      if (!current(attempt) || attempt.accepted) return;
      attempt.accepted = true;
      emitAccountSignal('retained_action', 'accepted', {
        flowId: attempt.flowId,
        operation,
        outcome: 'success'
      });
    },
    [current, operation]
  );
  const applied = useCallback(
    (attempt: FinanceDiagnosticAttempt, result: 'complete' | 'partial' = 'complete') => {
      if (!current(attempt) || !attempt.accepted || attempt.applied) return;
      attempt.applied = true;
      emitAccountSignal('retained_action', 'applied', {
        flowId: attempt.flowId,
        operation,
        outcome: 'success',
        result
      });
    },
    [current, operation]
  );
  const partial = useCallback(
    (attempt: FinanceDiagnosticAttempt) => {
      if (current(attempt))
        emitAccountSignal('retained_action', 'terminal', {
          flowId: attempt.flowId,
          operation,
          outcome: 'success',
          result: 'partial'
        });
    },
    [current, operation]
  );
  const fail = useCallback(
    (attempt: FinanceDiagnosticAttempt, cause: unknown) => {
      if (!current(attempt)) return;
      emitAccountSignal('retained_action', 'terminal', {
        flowId: attempt.flowId,
        operation,
        ...retainedFinanceFailure(cause)
      });
    },
    [current, operation]
  );
  const cancel = useCallback(
    (attempt: FinanceDiagnosticAttempt) => {
      if (!current(attempt)) return;
      emitAccountSignal('retained_action', 'terminal', {
        flowId: attempt.flowId,
        operation,
        outcome: 'cancelled',
        result: attempt.accepted
          ? 'partial'
          : operation === 'financeHistory'
            ? 'cancelled'
            : 'unknown'
      });
    },
    [current, operation]
  );
  return { start, current, accept, applied, partial, fail, cancel };
}
