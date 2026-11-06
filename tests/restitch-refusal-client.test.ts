// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRestitchScreenRefusals } from '../apps/web/src/api/client';
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('agentToken', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
function refusal(i: number, slot: 'start' | 'end' = 'start', settingsRevision?: string) {
  return {
    slot,
    materialId: `31000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    checksum: 'f'.repeat(32),
    ...(settingsRevision === undefined ? {} : { settingsRevision })
  };
}
function respond(refusals: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ refusals }))));
}
it('retains all 512 versions in each slot for one settings scope', async () => {
  const rows = [
    ...Array.from({ length: 512 }, (_, i) => refusal(i)),
    ...Array.from({ length: 512 }, (_, i) => refusal(i, 'end'))
  ];
  respond(rows);
  expect(
    await getRestitchScreenRefusals('30000000-0000-4000-8000-0000000000cc', 'settings')
  ).toEqual(rows);
});
it('does not discard a later settings scope from wildcard history', async () => {
  const rows = [
    ...Array.from({ length: 512 }, (_, i) => refusal(i, 'start', 'older')),
    refusal(700, 'end', 'current')
  ];
  respond(rows);
  expect(await getRestitchScreenRefusals('30000000-0000-4000-8000-0000000000cc', '*')).toEqual(
    rows
  );
});
it('rejects an overfull scope instead of silently returning a truncated success', async () => {
  respond(Array.from({ length: 513 }, (_, i) => refusal(i)));
  await expect(
    getRestitchScreenRefusals('30000000-0000-4000-8000-0000000000cc', 'settings')
  ).rejects.toThrow('INVALID_RESPONSE');
});
it('does not hide malformed metadata beyond the old prefix limit', async () => {
  respond([
    ...Array.from({ length: 512 }, (_, i) => refusal(i)),
    { ...refusal(700, 'end'), settingsRevision: {} }
  ]);
  await expect(
    getRestitchScreenRefusals('30000000-0000-4000-8000-0000000000cc', '*')
  ).rejects.toThrow('INVALID_RESPONSE');
});
