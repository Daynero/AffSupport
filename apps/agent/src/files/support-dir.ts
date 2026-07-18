import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CURRENT_DIR_NAME = 'Wishly';
const LEGACY_DIR_NAME = 'Local Video Compressor';

/**
 * Resolves `~/Library/Application Support/Wishly`.
 *
 * The pre-rebrand agent stored its queue state, managed images, estimate
 * cache, and drop-zone imports under "Local Video Compressor". When the new
 * directory does not exist yet and the legacy one does, it is adopted with a
 * single rename so the queue survives the upgrade to Wishly Agent.
 */
export function applicationSupportRoot() {
  const base = path.join(os.homedir(), 'Library', 'Application Support');
  const current = path.join(base, CURRENT_DIR_NAME);
  const legacy = path.join(base, LEGACY_DIR_NAME);
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      // Migration is best-effort: a fresh directory is created on demand.
    }
  }
  return current;
}
