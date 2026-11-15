import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnostics } from '../server/diagnostics-log.js';
import { currentPlatform } from '../platform/platform.js';

/**
 * Where a result goes when "next to the original" has no original to be next to.
 *
 * A browser hands a dropped file's **contents**, not its path. When the real
 * file cannot be located on disk, the agent keeps a private copy to work from —
 * and that copy is not the original. Treating it as one turns "save next to the
 * original" into "save inside Application Support, next to a duplicate of your
 * video that you never asked us to make", which is where results went to die:
 * buried, and deleted along with the import when the card was removed.
 *
 * So the fallback is a folder the person can actually find. Not because it is
 * where they wanted it, but because every alternative — an internal directory,
 * a guess at their intent — is worse than a visible one they can move from.
 *
 * The landing optimizer reached this conclusion first and wrote it down; the
 * compressor kept its own answer, which is exactly why the same drop landed in
 * two different places depending on which tool received it.
 */
export function uploadedOutputDir(folderName: string): string {
  // Overridable for the same reason the import root is: a test, a packaged
  // smoke run or a sandbox must be able to point this somewhere disposable
  // instead of writing into the person's real Downloads folder.
  const configured = process.env.AGENT_UPLOADED_OUTPUT_PATH?.trim();
  return configured
    ? path.join(configured, folderName)
    : path.join(os.homedir(), 'Downloads', folderName);
}

/** Results from the compressor queue when the source was an unlocatable upload. */
export const UPLOADED_VIDEO_OUTPUT_FOLDER = 'Soty';

/** Results from the landing optimizer when the landing arrived through the browser. */
export const UPLOADED_LANDING_OUTPUT_FOLDER = 'Soty Landings';

/** How long the Downloads check may wait on an open macOS permission question. */
export const UPLOADED_OUTPUT_CHECK_TIMEOUT_MS = 4_000;

/**
 * The folder results go to when it can be written, and a visible one that can
 * when it cannot.
 *
 * macOS asks before an app writes to Downloads, and the answer can be no — or
 * the question can still be open. A compression that cannot write its result
 * fails at the very end, after all the work. So the folder is tried first, with
 * a bounded wait, and when it refuses the result goes to `~/Movies/<folder>`
 * (`~/Videos` on Windows): a folder people can find that macOS does not guard.
 */
export async function writableUploadedOutputDir(
  folderName: string,
  timeoutMs = UPLOADED_OUTPUT_CHECK_TIMEOUT_MS
): Promise<string> {
  const preferred = uploadedOutputDir(folderName);
  if (process.env.AGENT_UPLOADED_OUTPUT_PATH?.trim()) {
    await mkdir(preferred, { recursive: true });
    return preferred;
  }
  if (await canWrite(preferred, timeoutMs)) return preferred;
  const fallback = path.join(
    os.homedir(),
    currentPlatform() === 'win32' ? 'Videos' : 'Movies',
    folderName
  );
  await mkdir(fallback, { recursive: true });
  return fallback;
}

async function canWrite(directory: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  const probe = (async (): Promise<'ok' | 'denied'> => {
    try {
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `.soty-write-check-${randomBytes(6).toString('hex')}`);
      await writeFile(file, '', { flag: 'wx' });
      await unlink(file).catch(() => undefined);
      return 'ok';
    } catch {
      return 'denied';
    }
  })();
  try {
    const outcome = await Promise.race([probe, expired]);
    if (outcome !== 'ok')
      diagnostics.record('drop', 'output_fallback', {
        outcome: outcome === 'timeout' ? 'timeout' : 'denied'
      });
    return outcome === 'ok';
  } finally {
    clearTimeout(timer);
  }
}
