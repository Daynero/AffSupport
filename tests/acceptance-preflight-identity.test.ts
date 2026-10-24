import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preflightLocal } from '../scripts/acceptance/preflight.mjs';

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  state: vi.fn(),
  files: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn()
}));
vi.mock('node:child_process', () => ({ execFileSync: calls.status }));
vi.mock('node:fs/promises', async original => ({
  ...(await original<object>()),
  readdir: calls.files
}));
vi.mock('../scripts/acceptance/private-state.mjs', async original => ({
  ...(await original<object>()),
  readPrivateState: calls.state
}));
vi.mock('../scripts/acceptance/variants.mjs', () => ({
  readOptionalVariants: async () => null
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

const namespace = 'acceptance-preflight-identity';
const target = {
  kind: 'local',
  environment: 'beta',
  namespace,
  marker: 'soty-acceptance',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};
const actors = Object.fromEntries(
  ['A', 'B', 'C', 'X', 'S'].map((alias, index) => [
    alias,
    {
      id: `36000000-0000-4000-8000-00000000000${index + 1}`,
      email: `${namespace}-${alias.toLowerCase()}@soty.invalid`,
      password: 's'.repeat(32),
      provisioned: true
    }
  ])
);
let authMarker: string;
let databaseMarker: string;
let migrationPresent: boolean;
let authIdMismatch: boolean;

beforeEach(() => {
  vi.resetAllMocks();
  authMarker = namespace;
  databaseMarker = namespace;
  migrationPresent = true;
  authIdMismatch = false;
  calls.state.mockResolvedValue({ namespace, actors, teams: {} });
  calls.files.mockResolvedValue(['20261206120000_recovery_output_fences.sql']);
  calls.status.mockReturnValue(
    JSON.stringify({ API_URL: target.authUrl, DB_URL: target.databaseUrl })
  );
  calls.query.mockImplementation(async (sql: string, parameters: string[] = []) => {
    if (sql.includes('from auth.users'))
      return { rowCount: 1, rows: [{ id: parameters[0], marker: databaseMarker }] };
    return {
      rowCount: migrationPresent ? 1 : 0,
      rows: migrationPresent ? [{ version: '20261206120000' }] : []
    };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/auth/v1/admin/users/'))
        return Response.json({
          id: authIdMismatch ? actors.B.id : url.split('/').at(-1),
          user_metadata: { acceptance_namespace: authMarker }
        });
      return Response.json({ ok: false, error: { code: 'AUTH_REQUIRED' } }, { status: 401 });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

it.each(['API_URL', 'DB_URL'])('refuses a different live %s before connecting', async key => {
  calls.status.mockReturnValue(
    JSON.stringify({
      API_URL: target.authUrl,
      DB_URL: target.databaseUrl,
      [key]: 'http://127.0.0.1:59999'
    })
  );
  await expect(preflightLocal(target)).rejects.toThrow('ACCEPTANCE_STACK_MISMATCH');
  expect(calls.connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['auth', 'database', 'subject'])('refuses mismatched fixture %s identity', async kind => {
  if (kind === 'auth') authMarker = 'acceptance-foreign';
  if (kind === 'database') databaseMarker = 'acceptance-foreign';
  if (kind === 'subject') authIdMismatch = true;
  const result = await preflightLocal(target);
  expect(result.ok).toBe(false);
  expect(result.targetIdentityVerified).toBe(false);
  expect(result.finalCandidateReady).toBe(false);
  expect(calls.end).toHaveBeenCalledOnce();
});

it('reports missing migrations without conflating fixture identity with candidate readiness', async () => {
  migrationPresent = false;
  const result = await preflightLocal(target);
  expect(result.ok).toBe(false);
  expect(result.targetIdentityVerified).toBe(true);
  expect(result.missingMigrations).toEqual(['20261206120000_recovery_output_fences.sql']);
  expect(result.finalCandidateReady).toBe(false);
});

it('keeps deployment and packaged identity unknown even when local fixture checks pass', async () => {
  const result = await preflightLocal(target);
  expect(result.ok).toBe(true);
  expect(result.targetIdentityVerified).toBe(true);
  expect(result.finalCandidateReady).toBe(false);
  expect(result.unknown).toContain('deployed-function-digests');
  expect(result.unknown).toContain('packaged-exact-sha');
});
