import { afterEach, expect, it, vi } from 'vitest';
import { assertReadOnlySql, setQueryExecutor } from '../scripts/analytics/db';
import { executeCommand, parseArgs } from '../scripts/analytics/cli';

afterEach(() => {
  setQueryExecutor(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['database-performance', 'database-health', 'database-tables', 'database-retention'])(
  'refuses historical %s snapshots before making any live request',
  async command => {
    vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'test-token');
    const fetcher = vi.fn(async () => {
      throw new Error('Unexpected live read');
    });
    const reader = vi.fn(async () => {
      throw new Error('Unexpected live read');
    });
    vi.stubGlobal('fetch', fetcher);
    setQueryExecutor(reader);
    await expect(
      executeCommand(parseArgs([command, '--as-of', '2020-01-01T00:00:00Z', '--json']))
    ).rejects.toThrow('--as-of is unavailable for current database snapshots');
    expect(fetcher).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  }
);

it('reports bounded performance aggregates without exposing SQL text or cron messages', async () => {
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'test-token');
  const statements: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, input: RequestInit) => {
    if (_url.includes('/analytics/endpoints/logs')) {
      const sql = new URL(_url).searchParams.get('sql') ?? '';
      assertReadOnlySql(sql);
      expect(sql).toContain('group by');
      expect(sql).not.toMatch(/select\s+event_message/i);
      return { ok: true, status: 200, json: async () => ({ result: [] }) };
    }
    if (_url.includes('/analytics/endpoints/metrics'))
      return {
        ok: true,
        status: 200,
        text: async () =>
          'node_load1 0.5\nnode_cpu_seconds_total{cpu="0",mode="idle"} 123\nnode_vmstat_pswpin 17\nnode_vmstat_pswpout 23\nnode_pressure_memory_stalled_seconds_total 2\nsecret_metric{email="private"} 1'
      };
    const body = JSON.parse(String(input.body)) as { query: string; read_only: boolean };
    expect(body.read_only).toBe(true);
    assertReadOnlySql(body.query);
    statements.push(body.query);
    return { ok: true, json: async () => (statements.length === 1 ? [{ available: true }] : []) };
  });
  const result = await executeCommand(parseArgs(['database-performance', '--json']));
  expect(result.data).toMatchObject({ statements: [], activity: [], jobs: [] });
  expect(result.data).toMatchObject({
    platform: {
      metrics: {
        values: {
          node_load1: 0.5,
          node_cpu_seconds_total_idle: 123,
          node_vmstat_pswpin: 17,
          node_vmstat_pswpout: 23,
          node_pressure_memory_stalled_seconds_total: 2
        }
      }
    }
  });
  expect(JSON.stringify(result.data)).not.toContain('private');
  expect(statements).toHaveLength(8);
  expect(statements[1]).toContain('limit 30');
  expect(statements[1]).not.toMatch(/select\s+query\s*[,\n]/i);
  expect(statements[4]).toContain("interval '1 hour'");
  expect(statements[4]).not.toMatch(/select\s+.*return_message/);
});

it('keeps absent SQL timing support explicit while still reporting waits and jobs', async () => {
  vi.stubEnv('SUPABASE_ACCESS_TOKEN', 'test-token');
  let requests = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/analytics/endpoints/')) return { ok: false, status: 403 };
    requests += 1;
    return { ok: true, json: async () => (requests === 1 ? [{ available: false }] : []) };
  });
  const result = await executeCommand(parseArgs(['database-performance', '--json']));
  expect(result.data).toMatchObject({ statements: { status: 'unavailable' } });
  expect(requests).toBe(6);
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
