import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { allOf, itRequiring, requireBinaries, requirePlatform } from './support/requires.js';

/**
 * These cases drive the release runner against a real filesystem: POSIX file
 * modes, unix socket paths, `#!/bin/sh` stand-ins on PATH and the executable
 * bit. On Windows they fail on the platform rather than on the behaviour — and
 * they would never run there anyway, because a release is cut on the owner's
 * Mac and Windows artifacts come back from CI.
 */
/**
 * The shell is part of the requirement, not part of the platform.
 *
 * The script under test is zsh, which every Mac has and a Linux CI image does
 * not. Asking only for the platform let the case run on a runner with no zsh,
 * where `spawnSync` returns a null status because nothing was ever spawned, and
 * the assertion read `expected null to be +0` -- a sentence about the image,
 * dressed as a sentence about admission. It blocked a release on a Windows
 * installer that had nothing to do with it.
 */
const posixReleaseHost = allOf(requirePlatform('darwin', 'linux'), await requireBinaries('zsh'));

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
