import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { saveState } from '../apps/agent/src/queue/store.js';
import { describeRequiring, requirePlatform } from './support/requires.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

/**
 * The queue state names every file the user has worked on.
 *
 * On a shared machine the default creation mode makes that list readable by
 * every other account — not the contents of the videos, but their names, their
 * locations, and when they were touched, which for a lot of people is the more
 * sensitive half.
 *
 * The directory is checked as well as the file, because a readable directory
 * leaks the names even when the file inside it cannot be opened.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => removeTemporaryDirectory(directory)));
});

describeRequiring(requirePlatform('darwin', 'linux'), 'persisted state permissions', () => {
  it('is readable by its owner and nobody else', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-state-perms-'));
    directories.push(root);
    const file = path.join(root, 'nested', 'state.json');

    await saveState({ jobs: [], settings: undefined, batch: null } as never, file);

    const fileMode = (await stat(file)).mode & 0o777;
    const directoryMode = (await stat(path.dirname(file))).mode & 0o777;
    expect(fileMode & 0o077).toBe(0);
    expect(directoryMode & 0o077).toBe(0);
  });

  it('tightens a directory that already existed', async () => {
    // `mkdir`'s mode is only honoured on creation, and almost every run is not
    // the first — so the interesting case is the second save, not the first.
    const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-state-perms-'));
    directories.push(root);
    const file = path.join(root, 'state.json');

    await saveState({ jobs: [], settings: undefined, batch: null } as never, file);
    await saveState({ jobs: [], settings: undefined, batch: null } as never, file);

    expect((await stat(root)).mode & 0o077).toBe(0);
  });
});
