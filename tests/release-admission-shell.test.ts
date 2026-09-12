import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps standalone packaging usable but fails closed for a partial runner admission', () => {
  const standalone = spawnSync(
    'zsh',
    ['-c', 'source scripts/release-admission.zsh; release_require_admission'],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  expect(standalone.status).toBe(0);
  const partial = spawnSync(
    'zsh',
    ['-c', 'source scripts/release-admission.zsh; release_require_admission'],
    {
      cwd: process.cwd(),
      env: { ...process.env, SOTY_RELEASE_ADMIT_SOCKET: '/missing.sock' },
      encoding: 'utf8'
    }
  );
  expect(partial.status).not.toBe(0);
  expect(partial.stderr).toContain('without a request message');
});
