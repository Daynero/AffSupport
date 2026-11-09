import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../scripts/analytics/db', () => ({ query: vi.fn() }));
import { query } from '../scripts/analytics/db';
import { investigatePrivacyFailure } from '../scripts/analytics/types';
import { getCatalogVideoSessionEvidence } from '../scripts/analytics/catalog-video-sessions';
const id = '47000000-0000-4000-8000-000000000001';
const row = {
  authority_id: id,
  set_id: id,
  team_id: id,
  actor_id: id,
  consumer_kind: 'launch',
  original_request_id: id,
  state: 'redeemed',
  session_valid: true,
  redeemed_at: '2026-11-08T16:00:00Z',
  expires_at: '2026-11-09T16:00:00Z',
  created_at: '2026-11-08T15:59:00Z',
  updated_at: '2026-11-08T16:00:00Z',
  safe_error_code: null
};
afterEach(() => vi.mocked(query).mockReset());
it('reads a bounded content-free one-set authority and strips credentials even from a malformed producer', async () => {
  vi.mocked(query).mockResolvedValue([
    {
      ...row,
      proof_secret: 'PRIVATE_PROOF',
      bearer: 'PRIVATE_BEARER',
      session_id: 'PRIVATE_SESSION'
    }
  ]);
  const result = await getCatalogVideoSessionEvidence(id);
  expect(result).toMatchObject({ status: 'available', records: [row], truncated: false });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(investigatePrivacyFailure(result)).toBeNull();
  const [sql, params] = vi.mocked(query).mock.calls[0]!;
  expect(sql).toMatch(/^select /u);
  expect(sql).toContain('original_request_id=$1::uuid');
  expect(sql).toContain('limit 51');
  expect(params).toEqual([id]);
  expect(sql).not.toMatch(/proof|bearer|token|session_id/iu);
});
it('preserves explicit unavailable evidence for invalid authorization or output claims', async () => {
  vi.mocked(query).mockResolvedValue([
    { ...row, session_valid: 'false' },
    { ...row, state: 'ready', redeemed_at: null },
    { ...row, state: 'accepted', set_id: null },
    { ...row, safe_error_code: 'PRIVATE_CAUSE' },
    { ...row, updated_at: '2000-01-01T00:00:00Z' }
  ]);
  expect(await getCatalogVideoSessionEvidence(id)).toMatchObject({
    status: 'unavailable',
    records: [],
    invalid_record_count: 5
  });
});
it('keeps prepared enrollment distinct from an accepted set and publication delivery', async () => {
  vi.mocked(query).mockResolvedValue([
    { ...row, state: 'prepared', set_id: null, redeemed_at: null, original_request_id: null }
  ]);
  const result = await getCatalogVideoSessionEvidence(id);
  expect(result).toMatchObject({
    status: 'available',
    records: [{ state: 'prepared', set_id: null }]
  });
  expect(result.blind_spots.some(value => value.includes('published catalog delivery'))).toBe(true);
});
it('returns at most fifty observations and reports truncation', async () => {
  vi.mocked(query).mockResolvedValue(Array.from({ length: 51 }, () => row));
  const result = await getCatalogVideoSessionEvidence(id);
  expect(result.records).toHaveLength(50);
  expect(result.truncated).toBe(true);
});
it.each([
  ['42501', 'read_denied'],
  ['42P01', 'schema_missing'],
  ['42703', 'schema_missing'],
  ['57014', 'timeout'],
  ['ANALYTICS_QUERY_TIMEOUT', 'timeout'],
  ['OTHER', 'query_failed']
])('keeps inaccessible evidence unknown (%s)', async (code, reason) => {
  vi.mocked(query).mockRejectedValue({ code });
  expect(await getCatalogVideoSessionEvidence(id)).toMatchObject({
    status: 'unavailable',
    records: [],
    missing_sources: [reason]
  });
});
it('does not reconstruct historical session validity or treat missing signals as success', async () => {
  expect(await getCatalogVideoSessionEvidence(id, '2026-11-01T00:00:00Z')).toMatchObject({
    status: 'historical_state_unknown',
    records: []
  });
  await expect(getCatalogVideoSessionEvidence('bad')).rejects.toThrow('INVALID_INPUT');
  expect(query).not.toHaveBeenCalled();
});

it('distinguishes an accepted original request waiting for its set from physical set acceptance', async () => {
  vi.mocked(query).mockResolvedValue([
    { ...row, state: 'accepted_unbound', set_id: null, redeemed_at: null }
  ]);
  expect(await getCatalogVideoSessionEvidence(id)).toMatchObject({
    status: 'available',
    records: [{ state: 'accepted_unbound', set_id: null }]
  });
});
