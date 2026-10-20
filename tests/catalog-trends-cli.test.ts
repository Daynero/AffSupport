import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const trends = vi.hoisted(() => vi.fn());
vi.mock('../scripts/analytics/catalog-schedule-trends', () => ({
  getCatalogScheduleTrends: trends
}));
const { parseArgs, executeCommand } = await import('../scripts/analytics/cli');
const dirs: string[] = [];
afterEach(() => {
  trends.mockReset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it('writes an explicitly requested offline report and passes a pinned period and actor scope to the readonly query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soty-catalog-report-'));
  dirs.push(dir);
  const file = join(dir, 'nested', 'report.html');
  trends.mockResolvedValue({
    status: 'ok',
    scope: { mode: 'actor', user_id: 'opaque-id' },
    period: { start: '2026-10-13T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
    coverage: { notes: [] }
  });
  const result = await executeCommand(
    parseArgs([
      'catalog-trends',
      'person@example.test',
      '--period',
      '7d',
      '--as-of',
      '2026-10-20T00:00:00Z',
      '--limit',
      '5',
      '--html',
      file,
      '--json'
    ])
  );
  expect(trends).toHaveBeenCalledWith(
    expect.objectContaining({ start: '2026-10-13T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' }),
    { user: 'person@example.test', limit: 5 }
  );
  expect(result.written).toEqual([file]);
  expect(readFileSync(file, 'utf8')).toContain('Як налаштовують автооновлення');
  expect(JSON.stringify(result.data)).not.toContain('person@example.test');
});
it('does not write a report unless requested and rejects ambiguous output options', async () => {
  trends.mockResolvedValue({ status: 'unsupported_by_producer' });
  const result = await executeCommand(parseArgs(['catalog-trends', '--json']));
  expect(result.written).toEqual([]);
  await expect(executeCommand(parseArgs(['events', '--html', 'report.html']))).rejects.toThrow(
    'only by catalog-trends'
  );
  expect(() => parseArgs(['catalog-trends', '--html'])).toThrow('output file');
  await expect(executeCommand(parseArgs(['catalog-trends', 'a', 'b']))).rejects.toThrow('Usage');
});
