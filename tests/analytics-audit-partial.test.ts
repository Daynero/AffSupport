import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { setQueryExecutor } from '../scripts/analytics/db';
import { getAudit } from '../scripts/analytics/queries';
import { resolvePeriod } from '../scripts/analytics/periods';
import { formatAudit } from '../scripts/analytics/format';
let db: AnalyticsTestDb;
const period = resolvePeriod('7d', undefined, '2026-11-05T12:00:00Z');
beforeAll(async () => {
  db = await createAnalyticsDb();
}, 30000);
afterAll(async () => {
  await db.close();
});
function failSource(match: (sql: string) => boolean, code: string) {
  setQueryExecutor(async (sql, params) => {
    if (match(sql))
      throw Object.assign(new Error('provider message must not reach the report'), { code });
    const result = await db.db.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
}
it.each(['57014', '42501', '42P01', '42703'])(
  'retains other audit sources after an event aggregation fails with %s',
  async code => {
    failSource(sql => sql.includes('from ev group by'), code);
    const data = await getAudit(period);
    expect(data.completeness).toBe('partial');
    expect(data.sources).toContainEqual(
      expect.objectContaining({ id: 'observed', status: 'unavailable' })
    );
    expect(data.sources).toContainEqual({ id: 'deliveryTotals', status: 'available' });
    const file = data.capabilities.find(c => c.id === 'team.file_ops')!;
    expect(file.status).toBe('partial');
    expect(file.samples).toBeNull();
    expect(file.missing).toContain('source_unavailable:observed');
    expect(formatAudit(data, period, [])).toContain('observed:');
    expect(JSON.stringify(data)).not.toContain('provider message');
  }
);
it('does not turn an unavailable delivery source into zero loss', async () => {
  failSource(sql => sql.includes('as reports,'), '57014');
  const data = await getAudit(period);
  expect(data.delivery.reports).toBeNull();
  expect(data.delivery.rejected).toBeNull();
  expect(data.delivery.note).toContain('unavailable');
});
it('does not swallow programming errors as missing coverage', async () => {
  failSource(sql => sql.includes('from ev group by'), '42601');
  await expect(getAudit(period)).rejects.toMatchObject({ code: '42601' });
});
