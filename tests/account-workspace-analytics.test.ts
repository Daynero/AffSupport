// @vitest-environment jsdom
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { emitAccountSignal } from '../apps/web/src/team/accounts/analytics';
import { diagnoseAccountEvents } from '../scripts/analytics/accounts';
import { sanitizeEventProperties } from '../scripts/analytics/sanitize';
import { getInspect } from '../scripts/analytics/queries';
import { sanitizeTeamAnalyticsProperties } from '../packages/shared/src/team/analytics';
const FLOW = '78500000-0000-4000-8000-000000000001';
const ASOF = '2026-10-18T18:00:00Z';
let store: AnalyticsTestDb;
beforeAll(async () => {
  store = await createAnalyticsDb();
  const files = (await readdir('supabase/migrations'))
    .filter(file => /^\d{14}_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .reverse();
  for (const file of files) {
    const sql = await readFile(`supabase/migrations/${file}`, 'utf8');
    const guard =
      /create or replace function public\.analytics_properties_are_safe_v2\s*\(payload jsonb\)[\s\S]*?\$\$;/.exec(
        sql
      );
    if (!guard) continue;
    await store.exec(guard[0]);
    return;
  }
  throw new Error('No production analytics ingestion guard found');
}, 30_000);
afterAll(async () => {
  await store?.close();
});

describe('account diagnostics typed producer → actual ingestion guard → persisted CLI evidence', () => {
  it.each([
    'financeClear',
    'financeUndo',
    'financeLegacyImport',
    'financeTransfer',
    'financeHistory',
    'financeExport'
  ] as const)(
    'accepts typed content-free retained operation %s through guard and CLI sanitizer',
    async operation => {
      const track = vi.fn();
      emitAccountSignal(
        'retained_action',
        'accepted',
        { flowId: FLOW, operation, outcome: 'success' },
        { track }
      );
      const properties = sanitizeTeamAnalyticsProperties(track.mock.calls[0][1]);
      const guarded = await store.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify(properties)]
      );
      expect(guarded.rows[0].safe).toBe(true);
      expect(sanitizeEventProperties(properties)).toMatchObject({ account_operation: operation });
      const leaked = await store.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify({ ...properties, amount: '125.35' })]
      );
      expect(leaked.rows[0].safe).toBe(false);
      const arbitrary = { ...properties, account_operation: 'financeUserSuppliedText' };
      expect(sanitizeEventProperties(arbitrary)).not.toHaveProperty('account_operation');
      const rejected = await store.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify(arbitrary)]
      );
      expect(rejected.rows[0].safe).toBe(false);
    }
  );

  it('separates accepted persistence from display, handles late start and replay without leaking values', async () => {
    const payloads: { event_name: string; properties: unknown }[] = [];
    const tracker = {
      track: vi.fn((event_name: string, properties: unknown) =>
        payloads.push({ event_name, properties })
      )
    };
    emitAccountSignal(
      'lifecycle',
      'accepted',
      { flowId: FLOW, result: 'retained_period_data', outcome: 'success' },
      tracker
    );
    // Queue delivery can reorder records and duplicate acceptance on receipt reconciliation.
    emitAccountSignal('lifecycle', 'requested', { flowId: FLOW, entity: 'rk' }, tracker);
    emitAccountSignal(
      'lifecycle',
      'accepted',
      { flowId: FLOW, result: 'retained_period_data', outcome: 'success' },
      tracker
    );
    for (const [index, event] of payloads.entries()) {
      const props = sanitizeTeamAnalyticsProperties(event.properties);
      const safe = await store.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify(props)]
      );
      expect(safe.rows[0].safe).toBe(true);
      await store.db.query(
        'insert into public.analytics_events(event_name,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$4)',
        [event.event_name, FLOW, props, `2026-10-18T10:00:0${index}Z`]
      );
    }
    let inspect = await getInspect(FLOW, ASOF);
    expect(inspect.found).toBe(true);
    if (!inspect.found) throw new Error('fixture');
    expect(inspect.capability).toBe('accounts.lifecycle');
    expect(diagnoseAccountEvents(inspect.events)[0].evidence).toEqual([
      'event:row-1',
      'event:row-2',
      'event:row-3'
    ]);
    expect(diagnoseAccountEvents(inspect.events)[0]).toMatchObject({
      state: 'saved_visibility_unknown',
      kind: 'insufficient'
    });
    await store.db.query(
      'insert into public.analytics_events(event_name,flow_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$4)',
      [
        'team_account_visible',
        FLOW,
        {
          account_action: 'lifecycle',
          account_stage: 'applied',
          account_result: 'retained_period_data',
          outcome: 'success'
        },
        '2026-10-18T10:00:04Z'
      ]
    );
    inspect = await getInspect(FLOW, ASOF);
    if (!inspect.found) throw new Error('fixture');
    expect(inspect.stages.observed).toContain('applied');
    expect(diagnoseAccountEvents(inspect.events)[0]).toMatchObject({
      state: 'visible',
      kind: 'fact'
    });
  });
  it('refuses secrets and unknown enum payloads at the real guard and CLI boundary', async () => {
    for (const payload of [
      { account_action: 'reorder', amount: 150 },
      { account_code: 'totp-secret' },
      { account_entity: 'g1-926' },
      { account_action: 'bearer token=secret' }
    ]) {
      const result = await store.db.query<{ safe: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) safe',
        [JSON.stringify(payload)]
      );
      expect(result.rows[0].safe).toBe(false);
      expect(sanitizeEventProperties(payload)).not.toHaveProperty('amount');
      expect(sanitizeEventProperties(payload)).not.toHaveProperty('account_code', 'totp-secret');
    }
  });
  it('keeps partial, denied, conflict, missing start and unknown response explicit', () => {
    const failure = (code: string, result: string) =>
      diagnoseAccountEvents([
        {
          event_id: '1',
          event_name: 'team_account_terminal',
          flow_id: FLOW,
          properties: {
            account_action: 'finance_edit',
            account_stage: 'terminal',
            account_code: code,
            account_result: result,
            outcome: 'failure'
          }
        }
      ])[0];
    expect(failure('PERMISSION_DENIED', 'denied')).toMatchObject({ state: 'failed', kind: 'fact' });
    expect(failure('ACCOUNT_ORDER_CONFLICT', 'conflict')).toMatchObject({
      state: 'failed',
      kind: 'fact'
    });
    expect(failure('UNKNOWN', 'unknown')).toMatchObject({ state: 'failed', kind: 'insufficient' });
    expect(
      diagnoseAccountEvents([
        {
          event_id: '1',
          event_name: 'team_account_terminal',
          flow_id: FLOW,
          properties: {
            account_action: 'finance_edit',
            account_stage: 'accepted',
            account_result: 'partial'
          }
        }
      ])[0]
    ).toMatchObject({ state: 'saved_visibility_unknown', kind: 'insufficient' });
    expect(
      diagnoseAccountEvents([
        {
          event_id: '1',
          event_name: 'team_account_stage',
          flow_id: FLOW,
          properties: { account_action: 'reorder', account_stage: 'captured' }
        }
      ])[0]
    ).toMatchObject({ state: 'missing_start', kind: 'insufficient' });
    expect(diagnoseAccountEvents([])).toEqual([]);
  });
  it('analytics persistence failures do not turn successful product actions into failures', () => {
    expect(() =>
      emitAccountSignal(
        'reorder',
        'accepted',
        { flowId: FLOW },
        {
          track: () => {
            throw new Error('quota');
          }
        }
      )
    ).not.toThrow();
  });
  it('preserves lifecycle partial failure and independent field attempts sharing its flow through the v3 envelope', async () => {
    const flowId = '78500000-0000-4000-8000-000000000020';
    const first = '78500000-0000-4000-8000-000000000021';
    const second = '78500000-0000-4000-8000-000000000022';
    const payloads: { event: string; properties: unknown }[] = [];
    const tracker = {
      track: vi.fn((event: string, properties: unknown) => {
        payloads.push({ event, properties });
      })
    };
    emitAccountSignal('lifecycle', 'requested', { flowId }, tracker);
    emitAccountSignal('finance_edit', 'requested', { flowId, attemptId: first }, tracker);
    emitAccountSignal(
      'finance_edit',
      'accepted',
      { flowId, attemptId: first, outcome: 'success' },
      tracker
    );
    emitAccountSignal(
      'finance_edit',
      'applied',
      { flowId, attemptId: first, outcome: 'success', result: 'complete' },
      tracker
    );
    emitAccountSignal('finance_edit', 'requested', { flowId, attemptId: second }, tracker);
    emitAccountSignal(
      'finance_edit',
      'terminal',
      {
        flowId,
        attemptId: second,
        outcome: 'failure',
        result: 'conflict',
        code: 'FINANCE_CONFLICT'
      },
      tracker
    );
    emitAccountSignal(
      'lifecycle',
      'terminal',
      { flowId, outcome: 'failure', result: 'partial', code: 'FINANCE_CONFLICT', count: 1 },
      tracker
    );
    for (const [index, item] of payloads.entries()) {
      const { attempt_id, ...properties } = sanitizeTeamAnalyticsProperties(item.properties);
      // The production v3 ingester lifts attempt_id into its own column.
      await store.db.query(
        'insert into public.analytics_events(event_name,flow_id,attempt_id,properties,occurred_at,created_at) values($1,$2,$3,$4,$5,$5)',
        [item.event, flowId, attempt_id ?? null, properties, `2026-10-18T11:00:0${index}Z`]
      );
    }
    const inspection = await getInspect(flowId, ASOF);
    if (!inspection.found) throw new Error('Missing correlated flow');
    expect(inspection.capability).toBe('accounts.lifecycle');
    expect(inspection.terminal?.outcome).toBe('failure');
    expect(inspection.stages.observed).not.toContain('applied');
    expect(inspection.accounts).toHaveLength(3);
    expect(inspection.accounts?.find(attempt => attempt.action === 'lifecycle')).toMatchObject({
      state: 'partial',
      result: 'partial',
      code: 'FINANCE_CONFLICT',
      attempt_id: null
    });
    expect(inspection.accounts?.find(attempt => attempt.attempt_id === first)).toMatchObject({
      action: 'finance_edit',
      state: 'visible'
    });
    expect(inspection.accounts?.find(attempt => attempt.attempt_id === second)).toMatchObject({
      action: 'finance_edit',
      state: 'failed',
      code: 'FINANCE_CONFLICT'
    });
    const child = await getInspect(second, ASOF);
    if (!child.found) throw new Error('Missing child attempt');
    expect(child.accounts).toHaveLength(1);
    expect(child.accounts?.[0]).toMatchObject({ attempt_id: second, state: 'failed' });
  });
  it('keeps a successful retained export with unknown OS delivery distinct from partially saved cells', () => {
    const evidence = diagnoseAccountEvents([
      {
        event_id: 'accepted',
        event_name: 'team_account_terminal',
        flow_id: FLOW,
        properties: {
          account_action: 'retained_action',
          account_operation: 'financeExport',
          account_stage: 'accepted',
          outcome: 'success'
        }
      },
      {
        event_id: 'unknown-display',
        event_name: 'team_account_terminal',
        flow_id: FLOW,
        properties: {
          account_action: 'retained_action',
          account_operation: 'financeExport',
          account_stage: 'terminal',
          outcome: 'success',
          account_result: 'partial'
        }
      }
    ]);
    expect(evidence[0]).toMatchObject({
      state: 'saved_visibility_unknown',
      kind: 'insufficient',
      result: 'partial'
    });
  });
});
