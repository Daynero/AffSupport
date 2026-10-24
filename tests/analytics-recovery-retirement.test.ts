import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ query: vi.fn(), schema: vi.fn() }));
vi.mock('../scripts/analytics/db.js', () => ({ query: fake.query }));
vi.mock('../scripts/analytics/schema.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../scripts/analytics/schema.js')>()),
  getSchema: fake.schema
}));
import { getRecoveryRetirementEvidence } from '../scripts/analytics/recovery-retirement';
const ACTOR = 'e1670000-0000-4000-8000-000000000001';
const ATTEMPT = 'e1670000-0000-4000-8000-000000000002';
const INSTALLATION = 'e1670000-0000-4000-8000-000000000003';
const AS_OF = '2026-10-22T20:00:00.000Z';
const row = {
  actor_id: ACTOR,
  attempt_id: ATTEMPT,
  installation_id: INSTALLATION,
  retired_count: 0,
  confirmed_at: '2026-10-22T19:00:00.000Z'
};
beforeEach(() => {
  fake.query.mockReset();
  fake.schema.mockReset();
  fake.schema.mockResolvedValue({ tables: { analytics_recovery_retirement: true }, events: {} });
});
it('keeps an unavailable receipt projection explicit without issuing unsupported SQL', async () => {
  fake.schema.mockResolvedValue({ tables: {} });
  expect(await getRecoveryRetirementEvidence(ACTOR, null, AS_OF)).toMatchObject({
    supported: false,
    receipts: [],
    blind_spots: expect.arrayContaining([expect.stringContaining('unavailable')])
  });
  expect(fake.query).not.toHaveBeenCalled();
});
it('scopes authoritative confirmation without inventing browser receipt or native cleanup', async () => {
  fake.query.mockResolvedValue([{ ...row, unexpected_secret: 'must-never-escape' }]);
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF);
  expect(result.receipts).toEqual([
    { ...row, server_outcome: 'confirmed', browser_outcome: 'unknown', native_cleanup: 'unknown' }
  ]);
  expect(fake.query.mock.calls[0]![0]).toContain('limit 101');
  expect(fake.query.mock.calls[0]![1]).toEqual([ACTOR, null, AS_OF, 'any']);
  expect(JSON.stringify(result)).not.toContain('must-never-escape');
});
it('refuses malformed subject scope without falling back to all actors', async () => {
  const result = await getRecoveryRetirementEvidence('not-a-subject', null, AS_OF);
  expect(result.receipts).toEqual([]);
  expect(fake.query).not.toHaveBeenCalled();
});
it('does not turn unrelated, future or malformed receipt rows into facts', async () => {
  fake.query.mockResolvedValue([
    {
      ...row,
      actor_id: 'e1670000-0000-4000-8000-000000000099',
      installation_id: 'e1670000-0000-4000-8000-000000000098',
      attempt_id: 'e1670000-0000-4000-8000-000000000097'
    },
    { ...row, confirmed_at: '2026-10-23T19:00:00.000Z' },
    { ...row, retired_count: -1 }
  ]);
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF);
  expect(result.receipts).toEqual([]);
  expect(result.blind_spots.length).toBeGreaterThan(0);
});

it('does not attribute another actor receipt merely because its chosen attempt UUID equals the investigated actor', async () => {
  fake.query.mockResolvedValue([
    { ...row, actor_id: 'e1670000-0000-4000-8000-000000000099', attempt_id: ACTOR }
  ]);
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF, 'actor');
  expect(result.receipts).toEqual([]);
});

it('keeps bounded detail truncation explicit', async () => {
  fake.query.mockResolvedValue(
    Array.from({ length: 101 }, (_, index) => ({
      ...row,
      attempt_id: `e1670000-0000-4000-8000-${String(index).padStart(12, '0')}`
    }))
  );
  const result = await getRecoveryRetirementEvidence(ACTOR, null, AS_OF);
  expect(result.receipts).toHaveLength(100);
  expect(result.blind_spots.some(value => value.includes('truncated'))).toBe(true);
});
