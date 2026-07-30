import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFileName } from '../platform/platform.js';

export interface SaveWithTranslationResult {
  folderPath: string;
  movedMediaPath: string;
}

/**
 * Packages a finished creative next to its source: creates a folder named
 * "<language label> <character count>" in the creative's directory, moves the
 * creative inside, and writes a text file with the transcript followed by its
 * translation. Returns the new paths so the queue can re-point the job at the
 * moved media (keeping reveal/preview working).
 */
export async function saveWithTranslation(options: {
  sourcePath: string;
  /** Localized source-language display name, e.g. "Урду". */
  languageLabel: string;
  transcriptText: string;
  translationText: string;
  /** Localized transcript file name, e.g. "Транскрипція.txt". */
  transcriptFileName: string;
}): Promise<SaveWithTranslationResult> {
  const parent = path.dirname(options.sourcePath);
  const characters = options.transcriptText.length;
  const folderBase =
    sanitizeFileName(`${options.languageLabel} ${characters}`.trim()) || `Transcript ${characters}`;

  // Claim a fresh directory; a duplicate name gets a numeric suffix instead of
  // silently mixing two exports.
  let folderPath = path.join(parent, folderBase);
  for (let suffix = 2; ; suffix += 1) {
    try {
      await mkdir(folderPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      folderPath = path.join(parent, `${folderBase} (${suffix})`);
    }
  }

  const movedMediaPath = path.join(folderPath, path.basename(options.sourcePath));
  try {
    await rename(options.sourcePath, movedMediaPath);
  } catch {
    // Cross-device moves cannot rename; copy then remove the original.
    await copyFile(options.sourcePath, movedMediaPath);
    await unlink(options.sourcePath).catch(() => {});
  }

  const fileName = sanitizeFileName(options.transcriptFileName) || 'Transcript.txt';
  const body = `${options.transcriptText.trim()}\n\n---\n\n${options.translationText.trim()}\n`;
  await writeFile(path.join(folderPath, fileName), body, 'utf8');

  return { folderPath, movedMediaPath };
}
