import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { appSupportRoot } from '../platform/platform.js';

const CURRENT_DIR_NAME = 'Wishly';
const LEGACY_DIR_NAME = 'Local Video Compressor';

/**
 * Resolves the per-user Wishly data directory (`~/Library/Application
 * Support/Wishly` on macOS; see platform.appSupportRoot for other systems).
 *
 * The pre-rebrand agent stored its queue state, managed images, estimate
 * cache, and drop-zone imports under "Local Video Compressor". When the new
 * directory does not exist yet and the legacy one does, it is adopted with a
 * single rename so the queue survives the upgrade to Wishly Agent. That
 * history only ever existed on macOS, so the rename stays darwin-only.
 */
export function applicationSupportRoot() {
  const base = appSupportRoot();
  const configured = process.env.AGENT_SUPPORT_DIRECTORY_NAME?.trim();
  const current = path.join(base, configured || CURRENT_DIR_NAME);
  if (configured && configured !== CURRENT_DIR_NAME) return current;
  if (process.platform === 'darwin') {
    const legacy = path.join(base, LEGACY_DIR_NAME);
    if (!existsSync(current) && existsSync(legacy)) {
      try {
        renameSync(legacy, current);
      } catch {
        // Migration is best-effort: a fresh directory is created on demand.
      }
    }
  }
  return current;
}
