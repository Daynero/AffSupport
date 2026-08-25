import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary directories that clean themselves up, and survive losing the race.
 *
 * Forty-one test files open a temp directory and remove it afterwards, and the
 * removal is where they differ in ways that matter. `rm(recursive, force)` is
 * not atomic: it walks the tree, and anything still writing into it — a queue
 * worker that has been asked to stop but has not finished flushing, a child
 * process mid-exit — makes the walk fail with ENOTEMPTY on a directory that was
 * empty a moment earlier.
 *
 * That failure only shows up under load, which is the worst kind: it passes
 * alone, fails in the full suite, and reads as a mysterious flake rather than
 * as the ordinary race it is. Node's own retry loop is the fix — it re-walks
 * rather than giving up on the first surprise.
 */

/** How many times to re-walk a directory that changed underneath the removal. */
const CLEANUP_RETRIES = 8;
const CLEANUP_RETRY_DELAY_MS = 40;

/** Removes a directory, tolerating one that is still settling. */
export async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: CLEANUP_RETRIES,
    retryDelay: CLEANUP_RETRY_DELAY_MS
  });
}

/**
 * Creates a temp directory and registers its removal.
 *
 * The returned `cleanup` is safe to call more than once and never throws: a
 * test that fails should report why it failed, not be replaced by an error
 * about a directory.
 */
export async function temporaryDirectory(prefix = 'wishly-test-'): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  let removed = false;
  return {
    path: directory,
    cleanup: async () => {
      if (removed) return;
      removed = true;
      try {
        await removeTemporaryDirectory(directory);
      } catch {
        // A directory left behind in the OS temp area is a smaller problem than
        // an afterEach that throws over one.
      }
    }
  };
}
