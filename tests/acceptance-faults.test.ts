import { expect, it } from 'vitest';
import {
  FAULT_KINDS,
  parseFaultRequest,
  armFaultDescriptor,
  transitionFault
} from '../scripts/acceptance/fault-model.mjs';

const namespace = 'acceptance-fault-model';
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  faultId: id(1),
  kind: 'lost_acceptance_response',
  actorId: id(2),
  teamId: id(3),
  operationId: id(4),
  flowId: id(5),
  ttlMs: 5000
};
const context = {
  namespace,
  actorId: id(2),
  teamId: id(3),
  operationId: id(4),
  flowId: id(5),
  phase: 'acceptance'
};

it.each([
  'lost_acceptance_response',
  'lost_status_response',
  'drive_429',
  'expired_cursor',
  'worker_crash_after_checkpoint',
  'delayed_delivery',
  'missing_signal'
])('accepts only the named scoped %s request', kind => {
  const input = { ...request, kind, ...(kind === 'delayed_delivery' ? { delayMs: 100 } : {}) };
  expect(parseFaultRequest(input, namespace)).toMatchObject({
    ok: true,
    value: { ...input, namespace }
  });
});

it.each(['url', 'sql', 'code', 'command', 'pid', 'headers', 'password', 'verified'])(
  'rejects arbitrary %s input rather than retaining it',
  key => {
    expect(parseFaultRequest({ ...request, [key]: 'private-value' }, namespace)).toEqual({
      ok: false,
      code: 'ACCEPTANCE_FAULT_INVALID'
    });
  }
);

it.each([0, -1, 999, 300001, 1.5, NaN, Infinity])(
  'rejects an unbounded or malformed TTL %s',
  ttlMs => {
    expect(parseFaultRequest({ ...request, ttlMs }, namespace)).toMatchObject({ ok: false });
  }
);

it('rejects foreign namespaces, malformed IDs and unsupported effects', () => {
  expect(FAULT_KINDS).toHaveLength(7);
  expect(parseFaultRequest(request, 'production')).toMatchObject({ ok: false });
  expect(
    parseFaultRequest({ ...request, operationId: '/private/provider/path' }, namespace)
  ).toMatchObject({ ok: false });
  expect(parseFaultRequest({ ...request, kind: 'execute_sql' }, namespace)).toMatchObject({
    ok: false
  });
  expect(parseFaultRequest({ ...request, delayMs: 100 }, namespace)).toMatchObject({ ok: false });
  expect(
    parseFaultRequest({ ...request, kind: 'delayed_delivery', delayMs: 5001 }, namespace)
  ).toMatchObject({ ok: false });
});

it('claims exactly once in the pure state machine and never describes intent as observed', () => {
  const entry = armFaultDescriptor(request, namespace, 10000);
  const claimed = transitionFault(entry, context, 'claim', 10001);
  expect(claimed).toMatchObject({ ok: true, changed: true, entry: { state: 'claimed' } });
  if (!claimed.ok) throw Error('claim failed');
  expect(transitionFault(claimed.entry, context, 'claim', 10002)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_NOT_ACTIVE'
  });
  expect(transitionFault(claimed.entry, context, 'observe', 10003)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_TRANSITION_INVALID'
  });
  const started = transitionFault(claimed.entry, context, 'effect-start', 10003);
  expect(started).toMatchObject({ ok: true, entry: { state: 'effect_started' } });
  if (!started.ok) throw Error('effect failed');
  expect(transitionFault(started.entry, context, 'observe', 10004)).toMatchObject({
    ok: true,
    entry: { state: 'observed' }
  });
});

it('refuses a different actor, team, operation, flow or phase without mutating state', () => {
  const entry = armFaultDescriptor(request, namespace, 10000);
  for (const key of ['actorId', 'teamId', 'operationId', 'flowId', 'phase', 'namespace']) {
    expect(
      transitionFault(
        entry,
        { ...context, [key]: key === 'phase' ? 'status' : id(9) },
        'claim',
        10001
      )
    ).toMatchObject({ ok: false, code: 'ACCEPTANCE_FAULT_SCOPE_MISMATCH' });
    expect(entry.state).toBe('armed');
  }
});

it('expires at the real deadline, supports repeated owned clear, and never extends TTL', () => {
  const entry = armFaultDescriptor(request, namespace, 10000);
  expect(transitionFault(entry, context, 'claim', 15000)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_EXPIRED'
  });
  const cleared = transitionFault(entry, context, 'clear', 16000);
  expect(cleared).toMatchObject({
    ok: true,
    changed: true,
    entry: { state: 'cleared', expiresAtMs: 15000 }
  });
  if (!cleared.ok) throw Error('clear failed');
  expect(transitionFault(cleared.entry, context, 'clear', 17000)).toMatchObject({
    ok: true,
    changed: false
  });
  expect(transitionFault(cleared.entry, context, 'claim', 17000)).toMatchObject({ ok: false });
  expect(entry.state).toBe('armed');
});

it('refuses corrupt stored metadata and still permits owned clear after a clock rollback', () => {
  const entry = armFaultDescriptor(request, namespace, 10000);
  expect(transitionFault({ ...entry, expiresAtMs: 999999 }, context, 'claim', 10001)).toMatchObject(
    { ok: false, code: 'ACCEPTANCE_FAULT_INVALID' }
  );
  const extraMetadata = { ...entry, unknown: 'private' };
  expect(transitionFault(extraMetadata, context, 'claim', 10001)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_INVALID'
  });
  expect(transitionFault(entry, context, 'claim', 9000)).toMatchObject({
    ok: false,
    code: 'ACCEPTANCE_FAULT_CLOCK_INVALID'
  });
  expect(transitionFault(entry, context, 'clear', 9000)).toMatchObject({
    ok: true,
    entry: { state: 'cleared', expiresAtMs: 15000 }
  });
});

it('allows late observation of a previously started effect without extending its lifetime', () => {
  const entry = armFaultDescriptor(request, namespace, 10000);
  const claimed = transitionFault(entry, context, 'claim', 10001);
  if (!claimed.ok) throw Error('claim failed');
  const effect = transitionFault(claimed.entry, context, 'effect-start', 10002);
  if (!effect.ok) throw Error('effect failed');
  expect(transitionFault(effect.entry, context, 'observe', 20000)).toMatchObject({
    ok: true,
    entry: { state: 'observed', expiresAtMs: 15000 }
  });
});

it('permits an explicit pre-acceptance intent only for acceptance-response loss', () => {
  expect(parseFaultRequest({ ...request, operationId: null }, namespace)).toMatchObject({
    ok: true,
    value: { operationId: null }
  });
  for (const kind of FAULT_KINDS.filter(value => value !== 'lost_acceptance_response'))
    expect(
      parseFaultRequest(
        {
          ...request,
          kind,
          operationId: null,
          ...(kind === 'delayed_delivery' ? { delayMs: 1 } : {})
        },
        namespace
      )
    ).toMatchObject({ ok: false });
  const intent = armFaultDescriptor({ ...request, operationId: null }, namespace, 10000);
  expect(transitionFault(intent, { ...context, operationId: null }, 'claim', 10001)).toMatchObject({
    ok: true,
    entry: { operationId: null, state: 'claimed' }
  });
});

it('names scan-request authority explicitly and never accepts an arbitrary resource table', () => {
  expect(
    parseFaultRequest({ ...request, resourceKind: 'catalog_sync_request' }, namespace)
  ).toMatchObject({ ok: true, value: { resourceKind: 'catalog_sync_request' } });
  expect(parseFaultRequest(request, namespace)).toMatchObject({
    ok: true,
    value: { resourceKind: 'team_operation' }
  });
  expect(
    parseFaultRequest({ ...request, resourceKind: 'public.any_table' }, namespace)
  ).toMatchObject({ ok: false });
});
