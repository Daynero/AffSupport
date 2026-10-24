import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { prepareDiagnosticReader } from '../scripts/acceptance/diagnostics.mjs';

const calls = vi.hoisted(() => ({
  fence: vi.fn(),
  preflight: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn()
}));
vi.mock('../scripts/acceptance/fixtures.mjs', async original => ({
  ...(await original<object>()),
  assertFixtureProvisionable: calls.fence
}));
vi.mock('../scripts/acceptance/preflight.mjs', () => ({ preflightLocal: calls.preflight }));
vi.mock('../scripts/acceptance/private-state.mjs', () => ({
  readPrivateState: calls.read,
  writePrivateState: calls.write
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = calls.connect;
      query = calls.query;
      end = calls.end;
    }
  }
}));

const target = {
  kind: 'local',
  environment: 'beta',
  namespace: 'acceptance-reader-cleanup',
  marker: 'soty-acceptance',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};
const role = `acceptance_ro_${createHash('sha256').update(target.namespace).digest('hex').slice(0, 12)}`;
beforeEach(() => {
  vi.resetAllMocks();
  calls.fence.mockResolvedValue(undefined);
  calls.preflight.mockResolvedValue({ targetIdentityVerified: true });
  calls.read.mockResolvedValue({ namespace: target.namespace, role, password: 'a'.repeat(64) });
  calls.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ held: true }], rowCount: 1 };
    if (sql.includes("where rolname='wishly_analytics_ro'"))
      return {
        rows: [
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
            rolreplication: false
          }
        ],
        rowCount: 1
      };
    if (sql.startsWith('select rolname')) return { rows: [{ rolname: role }], rowCount: 1 };
    if (sql.startsWith('select rolsuper'))
      return {
        rows: [
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
            rolreplication: false,
            rolcanlogin: true,
            rolconnlimit: 4,
            rolconfig: ['default_transaction_read_only=on', 'statement_timeout=30s']
          }
        ],
        rowCount: 1
      };
    if (sql.includes('pg_auth_members'))
      return { rows: [{ rolname: 'wishly_analytics_ro', admin_option: false }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

it('does not recreate diagnostic privileges after a cleanup checkpoint exists', async () => {
  calls.fence.mockRejectedValue(new Error('ACCEPTANCE_FIXTURE_CLEANUP_PENDING'));
  await expect(prepareDiagnosticReader(target)).rejects.toThrow(
    'ACCEPTANCE_FIXTURE_CLEANUP_PENDING'
  );
  expect(calls.preflight).not.toHaveBeenCalled();
  expect(calls.connect).not.toHaveBeenCalled();
  expect(calls.write).not.toHaveBeenCalled();
});

it('checks the durable cleanup fence again after acquiring the shared namespace lock', async () => {
  calls.fence
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('ACCEPTANCE_FIXTURE_CLEANUP_PENDING'));
  await expect(prepareDiagnosticReader(target)).rejects.toThrow(
    'ACCEPTANCE_FIXTURE_CLEANUP_PENDING'
  );
  expect(calls.query.mock.calls.some(([sql]) => String(sql).startsWith('create role'))).toBe(false);
  expect(calls.end).toHaveBeenCalledOnce();
});

it('refuses a busy cleanup/provisioning scope instead of waiting or mutating it', async () => {
  calls.query.mockResolvedValue({ rows: [{ held: false }], rowCount: 1 });
  await expect(prepareDiagnosticReader(target)).rejects.toThrow('ACCEPTANCE_FIXTURE_BUSY');
  expect(calls.query.mock.calls.some(([sql]) => String(sql).startsWith('create role'))).toBe(false);
});

it('reuses the existing restricted role under the same lock used by fixture cleanup', async () => {
  const result = await prepareDiagnosticReader(target);
  expect(result.role).toBe(role);
  expect(calls.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_xact_lock'), [
    `acceptance-fixtures:${target.namespace}`
  ]);
  expect(calls.fence).toHaveBeenCalledTimes(2);
  expect(calls.query.mock.calls.some(([sql]) => String(sql).startsWith('create role'))).toBe(false);
});
