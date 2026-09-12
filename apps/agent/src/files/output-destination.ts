import os from 'node:os';
import path from 'node:path';

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
