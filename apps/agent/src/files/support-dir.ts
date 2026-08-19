import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { appSupportRoot, legacySupportDirectoryMigration } from '../platform/platform.js';

const CURRENT_DIR_NAME = 'Soty';
const LEGACY_DIR_NAMES = ['Wishly', 'Local Video Compressor'];

/**
 * Resolves the per-user Soty data directory (`~/Library/Application
 * Support/Soty` on macOS; see platform.appSupportRoot for other systems).
 *
 * The pre-rebrand agent stored its queue state, managed images, estimate
 * cache, and drop-zone imports under "Local Video Compressor". When the new
 * directory does not exist yet and the legacy one does, it is adopted with a
 * single rename so the queue survives upgrades through the Wishly and Soty
 * brands. That
 * history only ever existed on macOS, so the rename stays darwin-only.
 */
export function applicationSupportRoot() {
  const base = appSupportRoot();
  const configured = process.env.AGENT_SUPPORT_DIRECTORY_NAME?.trim();
  const current = path.join(base, configured || CURRENT_DIR_NAME);
  if (configured && configured !== CURRENT_DIR_NAME) return current;
  if (legacySupportDirectoryMigration()) {
    const legacy = LEGACY_DIR_NAMES.map(name => path.join(base, name)).find(candidate =>
      existsSync(candidate)
    );
    if (!existsSync(current) && legacy) {
      try {
        renameSync(legacy, current);
      } catch {
        // Migration is best-effort: a fresh directory is created on demand.
      }
    }
  }
  return current;
}
