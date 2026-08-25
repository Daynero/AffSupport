import { stat, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePersistedPowerState, type PersistedPowerState } from '@video-compressor/shared';
import { applicationSupportRoot } from '../files/support-dir.js';
import { currentPlatform } from '../platform/platform.js';

/** Owner-only: this file names the user's own work; see queue/store.ts. */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIRECTORY = 0o700;

/**
 * Removes group and other access, and changes nothing else.
 *
 * Deliberately not `chmod(0o700)`: setting the mode outright would *restore*
 * owner permissions somebody had removed on purpose — a read-only state
 * directory is a legitimate thing for an administrator, or a test, to arrange,
 * and quietly making it writable again would defeat both. Only the bits that
 * leak to other accounts are cleared.
 */
async function tightenDirectory(directory: string): Promise<void> {
  if (currentPlatform() === 'win32') return;
  try {
    const current = (await stat(directory)).mode & 0o777;
    if ((current & 0o077) === 0) return;
    await chmod(directory, current & ~0o077);
  } catch {
    // Best effort: a directory we cannot inspect is one we cannot tighten, and
    // failing the save over it would trade a privacy nicety for lost work.
  }
}

/**
 * Where the power limit lives.
 *
 * Its own file, not `state.json`: that store belongs to the compressor queue,
 * and mixing a server-wide facility into one tool's schema would couple their
 * corruption blast radius. Agent-owned rather than browser-owned, because the
 * agent is the thing that must honour the limit — including for work already
 * running when no browser tab is open.
 *
 * Per machine, never synced to the account: the value describes *this*
 * computer's capacity, so carrying "20%" from a laptop to a workstation would
 * be actively wrong.
 */
export function powerStatePath(): string {
  return process.env.AGENT_POWER_STATE_PATH ?? path.join(applicationSupportRoot(), 'power.json');
}

/**
 * Reads the stored limit, or null when there is nothing usable to read.
 *
 * A missing, unparseable, wrong-shaped, or out-of-range file yields null and
 * the caller keeps the default. The safe failure direction is "Soty runs at
 * full speed" — never "Soty is mysteriously stuck at 3%".
 */
export async function loadPowerState(
  filePath = powerStatePath()
): Promise<PersistedPowerState | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = parsePersistedPowerState(parsed);
  return result.ok ? result.value : null;
}

/**
 * Writes the limit atomically: a temp file in the same directory, then a
 * rename. A crash mid-write can therefore leave the old value or the new one,
 * never a half-written file that would read as corrupt on next boot.
 */
export async function savePowerLimit(
  limitPercent: number,
  filePath = powerStatePath()
): Promise<void> {
  const state: PersistedPowerState = { limitPercent, updatedAt: new Date().toISOString() };
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
  await tightenDirectory(directory);
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: OWNER_ONLY_FILE
    });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
