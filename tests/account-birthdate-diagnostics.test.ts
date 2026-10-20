import { expect, it, vi } from 'vitest';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
import { retainedFinanceFailure } from '../apps/web/src/team/accounts/finance/useRetainedFinanceDiagnostics';
import { diagnoseAccountEvents } from '../scripts/analytics/accounts';
import { sanitizeEventProperties } from '../scripts/analytics/sanitize';
const flow = '38000000-0000-4000-8000-000000000001';
it('carries the safe selected-day bucket through producer, sanitizer and agent-readable diagnosis', () => {
  const tracker = { track: vi.fn() };
  for (const stage of ['requested', 'accepted', 'applied'] as const)
    emitAccountSignal(
      'retained_action',
      stage,
      {
        flowId: flow,
        operation: 'createAccount',
        day: 'previous',
        ...(stage !== 'requested' ? { outcome: 'success' as const } : {}),
        ...(stage === 'applied' ? { result: 'complete' as const } : {})
      },
      tracker
    );
  const events = tracker.track.mock.calls.map(([event_name, properties], index) => ({
    event_id: `e-${index}`,
    event_name: String(event_name),
    properties: sanitizeEventProperties(properties)
  }));
  expect(diagnoseAccountEvents(events)).toEqual([
    expect.objectContaining({
      flow_id: flow,
      operation: 'createAccount',
      day: 'previous',
      state: 'visible',
      kind: 'fact'
    })
  ]);
  expect(diagnoseAccountEvents(events.slice(0, 2))).toEqual([
    expect.objectContaining({
      day: 'previous',
      state: 'saved_visibility_unknown',
      kind: 'insufficient'
    })
  ]);
  expect(
    sanitizeEventProperties({
      account_day: '2026-10-17',
      starts_on: '2026-10-17',
      account_name: 'private'
    })
  ).toEqual({});
});
it('reports pre-birth money rejection as a known failure instead of an unknown result', () => {
  const failure = retainedFinanceFailure({ code: 'DATE_BEFORE_AGENT' });
  expect(failure).toEqual({ code: 'DATE_BEFORE_AGENT', result: 'failed', outcome: 'failure' });
  const tracker = { track: vi.fn() };
  emitAccountSignal(
    'retained_action',
    'terminal',
    { flowId: flow, operation: 'financeLegacyImport', day: 'historical', ...failure },
    tracker
  );
  const call = tracker.track.mock.calls[0];
  expect(
    diagnoseAccountEvents([
      { event_id: 'denied', event_name: String(call[0]), properties: call[1] }
    ])
  ).toEqual([
    expect.objectContaining({
      day: 'historical',
      code: 'DATE_BEFORE_AGENT',
      state: 'failed',
      kind: 'fact'
    })
  ]);
});
