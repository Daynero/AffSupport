import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPhase } from '../scripts/lib/gate.mjs';

describe('resource-constrained verification', () => {
  it('finishes each gate before starting the next when serial mode is enabled', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'soty-gate-serial-'));
    const marker = JSON.stringify(path.join(directory, 'finished'));
    vi.stubEnv('SOTY_VERIFY_SERIAL', '1');
    try {
      const results = await runPhase([
        {
          id: 'producer',
          command: process.execPath,
          args: [
            '-e',
            `setTimeout(() => require('node:fs').writeFileSync(${marker}, 'done'), 100)`
          ],
          timeoutMs: 5_000
        },
        {
          id: 'consumer',
          command: process.execPath,
          args: ['-e', `if (!require('node:fs').existsSync(${marker})) process.exit(1)`],
          timeoutMs: 5_000
        },
        {
          id: 'failure',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
          timeoutMs: 5_000
        }
      ]);
      expect(results.map(({ id, ok }) => ({ id, ok }))).toEqual([
        { id: 'producer', ok: true },
        { id: 'consumer', ok: true },
        { id: 'failure', ok: false }
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
