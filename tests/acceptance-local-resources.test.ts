import { beforeEach, expect, it, vi } from 'vitest';
import {
  openLocalResourceSampler,
  readLocalResourceSample,
  closeLocalResourceSampler
} from '../scripts/acceptance/local-resources.mjs';

const calls = vi.hoisted(() => ({
  preflight: vi.fn(),
  reader: vi.fn(),
  client: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  now: vi.fn()
}));
vi.mock('../scripts/acceptance/preflight.mjs', () => ({ preflightLocal: calls.preflight }));
vi.mock('../scripts/acceptance/diagnostics.mjs', async original => ({
  ...(await original<object>()),
  prepareDiagnosticReader: calls.reader
}));
vi.mock('node:perf_hooks', () => ({ performance: { now: calls.now } }));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: unknown) {
        calls.client(options);
      }
      connect = calls.connect;
      query = calls.query;
      end = calls.end;
    }
  }
}));

const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace: 'acceptance-resources-test',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};
const fingerprint = 'a'.repeat(64);
const role = 'acceptance_ro_123456789abc';
let identity: Record<string, unknown>;
let counters: Record<string, unknown>;
let now: number;
beforeEach(() => {
  vi.resetAllMocks();
  now = 1000;
  calls.now.mockImplementation(() => now);
  calls.preflight.mockResolvedValue({
    ok: true,
    targetIdentityVerified: true,
    targetFingerprint: fingerprint
  });
  calls.reader.mockResolvedValue({
    role,
    url: `postgresql://${role}:${'b'.repeat(64)}@127.0.0.1:54322/postgres`
  });
  identity = {
    database_name: 'postgres',
    database_oid: '5',
    boot: '1792810000.123',
    reader: role,
    read_only: 'on',
    attributes: {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolreplication: false,
      rolcanlogin: true,
      rolconnlimit: 4,
      rolconfig: ['default_transaction_read_only=on', 'statement_timeout=30s']
    },
    memberships: [{ rolname: 'wishly_analytics_ro', admin_option: false }]
  };
  counters = {
    stats_reset: '1792810000.456',
    database_bytes: '12000',
    connections: '3',
    xact_commit: '9007199254740993',
    xact_rollback: '0',
    blks_read: '10',
    blks_hit: '20',
    temp_bytes: '0',
    deadlocks: '0'
  };
  calls.query.mockImplementation(async (sql: string) => ({
    rowCount: 1,
    rows: [{ ...(sql.includes('pg_stat_database') ? counters : identity) }]
  }));
});

it('rejects remote or production targets before any readiness or SQL request', async () => {
  for (const patch of [
    { kind: 'hosted-acceptance' },
    { environment: 'production' },
    { authUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co' }
  ]) {
    await expect(openLocalResourceSampler({ ...target, ...patch })).rejects.toThrow(
      'ACCEPTANCE_TARGET_UNSAFE'
    );
  }
  expect(calls.preflight).not.toHaveBeenCalled();
  expect(calls.connect).not.toHaveBeenCalled();
});

it('requires actual readiness and never accepts a caller proof as authority', async () => {
  calls.preflight.mockResolvedValue({
    ok: false,
    targetIdentityVerified: true,
    targetFingerprint: fingerprint
  });
  await expect(openLocalResourceSampler(target)).rejects.toThrow(
    'ACCEPTANCE_RESOURCE_BINDING_FAILED'
  );
  expect(calls.reader).not.toHaveBeenCalled();
  await expect(
    readLocalResourceSample({ verified: true, targetFingerprint: fingerprint })
  ).rejects.toThrow('ACCEPTANCE_RESOURCE_HANDLE_INVALID');
});

it('uses a dedicated read-only client and keeps unavailable hosted measurements unknown', async () => {
  const handle = await openLocalResourceSampler(target);
  const sample = await readLocalResourceSample(handle);
  expect(sample.binding).toMatchObject({
    targetFingerprint: fingerprint,
    fullAcceptanceBinding: false
  });
  expect(sample.gauges.databaseBytes).toEqual({ status: 'observed', value: '12000' });
  expect(sample.gauges.cpu).toEqual({ status: 'unknown', reason: 'unsupported_local' });
  expect(sample.counters.xact_commit.delta).toEqual({
    status: 'unknown',
    reason: 'no_prior_sample'
  });
  expect(calls.client.mock.calls[0][0]).toMatchObject({
    options: '-c default_transaction_read_only=on -c statement_timeout=5000',
    query_timeout: 5000
  });
  expect(calls.query.mock.calls.every(([sql]) => /^\s*select\b/iu.test(sql))).toBe(true);
  expect(calls.end).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(sample)).not.toContain('postgresql:');
  expect(JSON.stringify(handle)).toBe('{}');
});

it('keeps exact counter deltas and detects a statistics reset', async () => {
  const handle = await openLocalResourceSampler(target);
  await readLocalResourceSample(handle);
  now += 2000;
  counters.xact_commit = '9007199254740995';
  const second = await readLocalResourceSample(handle);
  expect(second.counters.xact_commit.delta).toEqual({
    status: 'observed',
    delta: '2',
    perSecond: 1
  });
  now += 2000;
  counters.stats_reset = '1792810010.456';
  expect((await readLocalResourceSample(handle)).counters.xact_commit.delta).toEqual({
    status: 'unknown',
    reason: 'counter_reset'
  });
});

it('keeps missing measurements unknown rather than zero', async () => {
  const handle = await openLocalResourceSampler(target);
  counters.blks_read = null;
  counters.stats_reset = null;
  counters.database_bytes = null;
  const sample = await readLocalResourceSample(handle);
  expect(sample.counters.blks_read.value).toEqual({
    status: 'unknown',
    reason: 'missing_measurement'
  });
  expect(sample.gauges.databaseBytes).toEqual({ status: 'unknown', reason: 'missing_measurement' });
});

it.each(['reader', 'read_only', 'database_name', 'boot'])(
  'refuses changed SQL identity: %s',
  async key => {
    const handle = await openLocalResourceSampler(target);
    identity[key] = 'unexpected';
    await expect(readLocalResourceSample(handle)).rejects.toThrow(
      'ACCEPTANCE_RESOURCE_BINDING_FAILED'
    );
    await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_CLOSED');
  }
);

it('refuses elevated role permissions and changed Auth/database fixture binding', async () => {
  identity.attributes = { ...(identity.attributes as object), rolsuper: true };
  await expect(openLocalResourceSampler(target)).rejects.toThrow(
    'ACCEPTANCE_RESOURCE_BINDING_FAILED'
  );
  identity.attributes = { ...(identity.attributes as object), rolsuper: false };
  const handle = await openLocalResourceSampler(target);
  calls.preflight.mockResolvedValue({
    ok: true,
    targetIdentityVerified: true,
    targetFingerprint: 'c'.repeat(64)
  });
  await expect(readLocalResourceSample(handle)).rejects.toThrow(
    'ACCEPTANCE_RESOURCE_BINDING_FAILED'
  );
});

it('bounds lifetime, sampling cadence and count without extra SQL', async () => {
  const handle = await openLocalResourceSampler(target, { maxSamples: 2, ttlMs: 5000 });
  await readLocalResourceSample(handle);
  await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_INTERVAL');
  now += 1000;
  await readLocalResourceSample(handle);
  await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_LIMIT');
  const expiring = await openLocalResourceSampler(target, { ttlMs: 1000 });
  const before = calls.query.mock.calls.length;
  now += 1001;
  await expect(readLocalResourceSample(expiring)).rejects.toThrow('ACCEPTANCE_RESOURCE_EXPIRED');
  expect(calls.query).toHaveBeenCalledTimes(before);
});

it('revokes a closed handle and refuses copies or serialized handles', async () => {
  const handle = await openLocalResourceSampler(target);
  await expect(readLocalResourceSample({ ...handle })).rejects.toThrow(
    'ACCEPTANCE_RESOURCE_HANDLE_INVALID'
  );
  closeLocalResourceSampler(handle);
  closeLocalResourceSampler(handle);
  await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_CLOSED');
});

it('rejects invalid sampling options before starting probes', async () => {
  for (const options of [
    { ttlMs: 300001 },
    { maxSamples: 61 },
    { minimumIntervalMs: 0 },
    { sql: 'drop table x' }
  ])
    await expect(openLocalResourceSampler(target, options)).rejects.toThrow(
      'ACCEPTANCE_RESOURCE_OPTIONS_INVALID'
    );
  expect(calls.preflight).not.toHaveBeenCalled();
});

it('sanitizes query failures and always releases its owned connection', async () => {
  const handle = await openLocalResourceSampler(target);
  calls.query.mockRejectedValue(new Error('private connection password content'));
  await expect(readLocalResourceSample(handle)).rejects.toThrow(
    /^ACCEPTANCE_RESOURCE_READ_FAILED$/u
  );
  expect(calls.end).toHaveBeenCalledTimes(2);
});

it('sanitizes readiness and connection-close failures during binding creation', async () => {
  calls.preflight.mockRejectedValueOnce(new Error('private readiness credential'));
  await expect(openLocalResourceSampler(target)).rejects.toThrow(
    /^ACCEPTANCE_RESOURCE_READ_FAILED$/u
  );
  calls.end.mockRejectedValueOnce(new Error('private driver credential'));
  await expect(openLocalResourceSampler(target)).rejects.toThrow(
    /^ACCEPTANCE_RESOURCE_READ_FAILED$/u
  );
});

it('refuses overlapping reads and discards a result if the handle closes in flight', async () => {
  const handle = await openLocalResourceSampler(target);
  let finish: (() => void) | undefined;
  calls.preflight.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () =>
          resolve({ ok: true, targetIdentityVerified: true, targetFingerprint: fingerprint });
      })
  );
  const pending = readLocalResourceSample(handle);
  await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_BUSY');
  closeLocalResourceSampler(handle);
  finish?.();
  await expect(pending).rejects.toThrow('ACCEPTANCE_RESOURCE_CLOSED');
  expect(calls.query).toHaveBeenCalledTimes(1);
});

it('refuses results that arrive after the sampler deadline', async () => {
  const handle = await openLocalResourceSampler(target, { ttlMs: 1000 });
  calls.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_stat_database')) {
      now += 1001;
      return { rowCount: 1, rows: [counters] };
    }
    return { rowCount: 1, rows: [identity] };
  });
  await expect(readLocalResourceSample(handle)).rejects.toThrow('ACCEPTANCE_RESOURCE_EXPIRED');
  expect(calls.end).toHaveBeenCalledTimes(2);
});

it('copies verified target configuration before asynchronous work', async () => {
  const mutable = { ...target };
  const handle = await openLocalResourceSampler(mutable);
  mutable.authUrl = 'https://unrelated.invalid';
  mutable.databaseUrl = 'postgresql://unrelated.invalid/other';
  await readLocalResourceSample(handle);
  expect(calls.preflight.mock.calls.at(-1)?.[0]).toEqual(target);
});
