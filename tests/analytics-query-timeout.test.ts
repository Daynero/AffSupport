import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(async () => {}),
  configs: [] as Record<string, unknown>[]
}));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(config: Record<string, unknown>) {
        fixture.configs.push(config);
      }
      query = fixture.query;
      end = fixture.end;
    },
    types: { setTypeParser: vi.fn() }
  }
}));
import { getMaterialSharingEvidence } from '../scripts/analytics/material-sharing';
import { closePool, query } from '../scripts/analytics/db';
afterEach(async () => {
  await closePool();
  vi.unstubAllEnvs();
  fixture.configs.length = 0;
  fixture.query.mockReset();
});
it('bounds the client wait as well as server execution for a read-only analytics query', async () => {
  vi.stubEnv('ANALYTICS_DATABASE_URL', 'postgresql://reader@127.0.0.1:1/test');
  fixture.query.mockResolvedValue({ rows: [] });
  await query('select 1');
  expect(fixture.configs[0]).toMatchObject({
    query_timeout: 30000,
    connectionTimeoutMillis: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000'
  });
});
it.each([
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout'
])('classifies the driver deadline (%s) without exposing transport details', async message => {
  vi.stubEnv('ANALYTICS_DATABASE_URL', 'postgresql://reader@127.0.0.1:1/test');
  fixture.query.mockRejectedValue(Error(message));
  await expect(query('select 1')).rejects.toMatchObject({
    code: 'ANALYTICS_QUERY_TIMEOUT',
    message: 'Analytics read timed out'
  });
});
it('preserves an unrelated query failure', async () => {
  vi.stubEnv('ANALYTICS_DATABASE_URL', 'postgresql://reader@127.0.0.1:1/test');
  const failure = Object.assign(Error('synthetic syntax failure'), { code: '42601' });
  fixture.query.mockRejectedValue(failure);
  await expect(query('select 1')).rejects.toBe(failure);
});

it('keeps sharing sources explicitly unknown when the client read deadline expires', async () => {
  vi.stubEnv('ANALYTICS_DATABASE_URL', 'postgresql://reader@127.0.0.1:1/test');
  fixture.query.mockRejectedValue(Error('Query read timeout'));
  const result = await getMaterialSharingEvidence('47000000-0000-4000-8000-000000000071');
  expect(result.unavailable_sources).toEqual(['permission_receipts:timeout', 'related_ui:timeout']);
  expect(result.items).toEqual([]);
});
