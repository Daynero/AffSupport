import { expect, it } from 'vitest';
import { changeLocalTariffClock, validateClockInstant } from '../scripts/acceptance/clock.mjs';
const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace: 'acceptance-clock-test',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres'
};
it('accepts a canonical instant with a bounded real-time lease', () =>
  expect(validateClockInstant('2030-01-01T00:00:00.000Z', 60000)).toBe(true));
it.each([
  '2030-02-30T00:00:00.000Z',
  '2030-01-01',
  '2030-01-01T00:00:00Z',
  "2030-01-01';drop table x",
  '',
  null
])('rejects a noncanonical clock input %s', instant =>
  expect(validateClockInstant(instant, 60000)).toBe(false)
);
it.each([0, -1, 999, 3600001, Infinity, NaN, 1.5, '60000'])('rejects an unsafe real TTL %s', ttl =>
  expect(validateClockInstant('2030-01-01T00:00:00.000Z', ttl)).toBe(false)
);
it.each([
  { ...target, kind: 'hosted-acceptance' },
  { ...target, environment: 'production' },
  { ...target, databaseUrl: 'postgresql://postgres:synthetic@remote.example/postgres' },
  { ...target, marker: 'production' }
])('refuses unsafe target before filesystem/network work', async unsafe =>
  expect(
    await changeLocalTariffClock(unsafe, {
      kind: 'set',
      instant: '2030-01-01T00:00:00.000Z',
      ttlMs: 60000
    })
  ).toEqual({ ok: false, code: 'ACCEPTANCE_CLOCK_REFUSED' })
);
it('does not accept arbitrary operation fields', async () =>
  expect(await changeLocalTariffClock(target, { kind: 'clear', sql: 'untrusted payload' })).toEqual(
    { ok: false, code: 'ACCEPTANCE_CLOCK_REFUSED' }
  ));
