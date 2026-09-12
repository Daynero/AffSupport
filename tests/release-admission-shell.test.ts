import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { itRequiring, requirePlatform } from './support/requires.js';

/**
 * These cases drive the release runner against a real filesystem: POSIX file
 * modes, unix socket paths, `#!/bin/sh` stand-ins on PATH and the executable
 * bit. On Windows they fail on the platform rather than on the behaviour — and
 * they would never run there anyway, because a release is cut on the owner's
 * Mac and Windows artifacts come back from CI.
 */
const posixReleaseHost = requirePlatform('darwin', 'linux');

itRequiring(
  posixReleaseHost,
  'keeps standalone packaging usable but fails closed for a partial runner admission',
  () => {
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
  }
);
