import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(path.join(root, 'coverage-baseline.json'), 'utf8'));

it('keeps active coverage ratchets on existing source and records removed modules separately', () => {
  const missing = Object.keys(baseline.files).filter(file => !existsSync(path.join(root, file)));
  expect(missing).toEqual([]);
  for (const [file, record] of Object.entries(baseline.retired_files ?? {})) {
    const retired = record as { coverage: number; removed_in: string; reason: string };
    expect(existsSync(path.join(root, file))).toBe(false);
    expect(retired.coverage).toBeGreaterThanOrEqual(0);
    expect(retired.coverage).toBeLessThanOrEqual(100);
    expect(retired.removed_in).toMatch(/^[a-f0-9]{40}$/u);
    expect(retired.reason.length).toBeGreaterThan(0);
  }
});
