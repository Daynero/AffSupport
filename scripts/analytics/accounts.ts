import { sanitizeEventProperties } from './sanitize.js';

export interface AccountDiagnosticEvent {
  event_id: string;
  event_name: string;
  flow_id?: string | null;
  properties: unknown;
}
export interface AccountDiagnostic {
  flow_id: string;
  action: string;
  attempt_id: string | null;
  operation: string | null;
  day?: 'today' | 'previous' | 'historical';
  kind: 'fact' | 'hypothesis' | 'insufficient';
  state:
    | 'visible'
    | 'saved_visibility_unknown'
    | 'failed'
    | 'partial'
    | 'unfinished'
    | 'missing_start'
    | 'cancelled'
    | 'noop';
  result: string;
  code: string;
  evidence: string[];
}
/** Interpret sanitized persisted evidence, independently of delivery order. */
export function diagnoseAccountEvents(
  events: readonly AccountDiagnosticEvent[]
): AccountDiagnostic[] {
  const groups = new Map<
    string,
    { event: AccountDiagnosticEvent; props: ReturnType<typeof sanitizeEventProperties> }[]
  >();
  for (const event of events) {
    if (!event.event_name.startsWith('team_account_')) continue;
    const props = sanitizeEventProperties(event.properties);
    const flow = event.flow_id ?? props.flow_id;
    if (typeof flow !== 'string' || typeof props.account_action !== 'string') continue;
    // A parent lifecycle and its per-cell writes share a flow, never an
    // outcome. Keep each operation/attempt independent so one visible child
    // cannot turn a partial archive preparation into visible success.
    const key = JSON.stringify([
      flow,
      props.account_action,
      props.account_operation ?? null,
      props.attempt_id ?? null
    ]);
    const group = groups.get(key) ?? [];
    group.push({ event, props });
    groups.set(key, group);
  }
  return [...groups.values()].map(rows => {
    const visible = rows.find(row => row.event.event_name === 'team_account_visible');
    const failed = rows.find(row => ['failure', 'blocked'].includes(String(row.props.outcome)));
    const accepted = rows.find(row => row.props.account_stage === 'accepted');
    const requested = rows.find(row => row.props.account_stage === 'requested');
    const terminal = rows.find(row => row.props.account_stage === 'terminal');
    const cancelled = terminal?.props.outcome === 'cancelled';
    const noop = terminal?.props.account_result === 'noop';
    const partial =
      terminal?.props.account_result === 'partial' &&
      ['failure', 'blocked'].includes(String(terminal.props.outcome));
    const knownFailure =
      typeof failed?.props.account_code === 'string' &&
      !['UNKNOWN', 'NONE'].includes(failed.props.account_code);
    const state = visible
      ? 'visible'
      : partial
        ? 'partial'
        : cancelled
          ? 'cancelled'
          : noop
            ? 'noop'
            : failed
              ? 'failed'
              : accepted
                ? 'saved_visibility_unknown'
                : requested
                  ? 'unfinished'
                  : 'missing_start';
    const day = rows.find(row =>
      ['today', 'previous', 'historical'].includes(String(row.props.account_day))
    )?.props.account_day;
    const dayContext: Pick<AccountDiagnostic, 'day'> =
      day === 'today' || day === 'previous' || day === 'historical' ? { day } : {};
    return {
      ...dayContext,
      flow_id: String(rows[0].event.flow_id ?? rows[0].props.flow_id),
      attempt_id: typeof rows[0].props.attempt_id === 'string' ? rows[0].props.attempt_id : null,
      operation:
        typeof rows[0].props.account_operation === 'string'
          ? rows[0].props.account_operation
          : null,
      action: String(rows[0].props.account_action),
      result: String((visible ?? terminal ?? accepted)?.props.account_result ?? 'unknown'),
      kind:
        visible || partial || cancelled || noop || knownFailure
          ? 'fact'
          : state === 'unfinished'
            ? 'hypothesis'
            : 'insufficient',
      state,
      code: String(failed?.props.account_code ?? 'NONE'),
      evidence: rows.map(row => `event:${row.event.event_id}`)
    };
  });
}
