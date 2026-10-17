import { afterEach, expect, it, vi } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';

afterEach(() => {
  setQueryExecutor(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('returns database metadata and explicit missing permissions without scanning private grants', async () => {
  const statements: string[] = [];
  setQueryExecutor(async sql => {
    assertReadOnlySql(sql);
    statements.push(sql);
    if (sql.includes('has_schema_privilege')) return [{ readable: false }];
    return [];
  });
  const result = await executeCommand(parseArgs(['database-health', '--json']));
  expect(result.data).toMatchObject({ grants: { status: 'insufficient_privileges' } });
  expect(statements.some(sql => sql.includes('from private.team_transfer_grants'))).toBe(false);
  expect(result.written).toEqual([]);
});

it('runs table audits with read-only API mode and keeps row content out of the result', async () => {
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'test-token');
  const requests: { query: string; read_only: boolean }[] = [];
  const fetcher = vi.fn(async (_url: string, input: RequestInit) => {
    const body = JSON.parse(String(input.body)) as { query: string; read_only: boolean };
    requests.push(body);
    assertReadOnlySql(body.query);
    const rows =
      requests.length === 1
        ? [
            {
              schema: 'public',
              name: 'team_materials',
              total_bytes: 1000,
              age_column: 'created_at'
            }
          ]
        : [];
    return { ok: true, json: async () => rows };
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await executeCommand(parseArgs(['database-tables', '--json']));
  expect(requests.length).toBeGreaterThan(5);
  expect(requests.every(request => request.read_only === true)).toBe(true);
  expect(requests[1]?.query).toContain('count(*)');
  expect(result.data).toMatchObject({ duplicates: [], legacy_sources: [] });
  expect(result.written).toEqual([]);
});

it('probes retention jobs without scanning user or transfer tables', async () => {
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'test-token');
  const statements: string[] = [];
  vi.stubGlobal('fetch', async (url: string, input: RequestInit) => {
    if (url.includes('/health?'))
      return { ok: true, json: async () => [{ name: 'auth', status: 'ACTIVE_HEALTHY' }] };
    const body = JSON.parse(String(input.body)) as { query: string; read_only: boolean };
    expect(body.read_only).toBe(true);
    assertReadOnlySql(body.query);
    statements.push(body.query);
    return { ok: true, json: async () => [] };
  });
  const result = await executeCommand(parseArgs(['database-retention', '--json']));
  expect(result.data).toMatchObject({ services: [{ name: 'auth', status: 'ACTIVE_HEALTHY' }] });
  expect(statements).toHaveLength(2);
  expect(statements.every(sql => !sql.includes('from private.team_transfer_grants'))).toBe(true);
  expect(statements.some(sql => sql.includes('cron.job_run_details'))).toBe(true);
});
