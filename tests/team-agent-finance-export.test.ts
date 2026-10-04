import { expect, it, vi } from 'vitest';
import { executeFinanceExport } from '../supabase/functions/team-finance-export/handler';
import type { FinanceSnapshot } from '@video-compressor/shared';

const snapshot: FinanceSnapshot = {
  schemaVersion: 1,
  teamId: '27000000-0000-4000-8000-000000000010',
  teamName: 'Test',
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'USD',
  generatedAt: '2026-10-03T10:00:00Z',
  accounts: [],
  agents: [],
  placements: [],
  fields: []
};
const input = { teamId: snapshot.teamId, from: snapshot.from, to: snapshot.to, timezone: 'UTC' };
it('uses one user-scoped snapshot and rechecks permission before returning the binary', async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: snapshot, error: null })
    .mockResolvedValueOnce({ data: [], error: null });
  const result = await executeFinanceExport(input, { rpc });
  expect(result.bytes[0]).toBe(0x50);
  expect(result.filename).toBe(`finance-${snapshot.teamId}-2026-09-01-2026-09-30.xlsx`);
  expect(rpc.mock.calls.map(c => c[0])).toEqual([
    'get_team_agent_finance',
    'list_team_agent_finance_legacy'
  ]);
});
it('returns no file when membership is revoked after snapshot creation', async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: snapshot, error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'PERMISSION_DENIED' } });
  await expect(executeFinanceExport(input, { rpc })).rejects.toThrow('PERMISSION_DENIED');
});
it('refuses invalid dates before querying and propagates cross-team denial', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PERMISSION_DENIED' } });
  await expect(executeFinanceExport({ ...input, from: '2026-02-30' }, { rpc })).rejects.toThrow(
    'INVALID_INPUT'
  );
  expect(rpc).not.toHaveBeenCalled();
  await expect(executeFinanceExport(input, { rpc })).rejects.toThrow('PERMISSION_DENIED');
});
