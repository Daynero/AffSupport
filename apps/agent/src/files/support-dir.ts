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
/**
 * The override, accepted only as a single directory name.
 *
 * It is joined onto the user's Application Support directory, so anything with
 * a separator in it — `../..`, an absolute path, a Windows drive letter —
 * relocates every state file the agent writes to a place of the caller's
 * choosing. It exists so tests can isolate their state, and one segment is all
 * that ever needed. A value that is not one is ignored rather than sanitised:
 * silently rewriting someone's configuration to a different directory is worse
 * than not honouring it.
 */
function supportDirectorySegment(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (/[\\/]/u.test(trimmed) || path.isAbsolute(trimmed)) return null;
  if (path.basename(trimmed) !== trimmed) return null;
  return trimmed;
}

export function applicationSupportRoot() {
  const base = appSupportRoot();
  const configured = supportDirectorySegment(process.env.AGENT_SUPPORT_DIRECTORY_NAME);
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
