import { copyFile, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { replaceFile } from '../files/replace-file.js';
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

  // The transcript is written before the media moves: the write is the step that can fail
  // for reasons of its own (a full disk, a name the filesystem refuses), and failing after
  // the move left the person's file in a new folder that the job did not know about.
  const fileName = sanitizeFileName(options.transcriptFileName) || 'Transcript.txt';
  const body = `${options.transcriptText.trim()}\n\n---\n\n${options.translationText.trim()}\n`;
  await writeFile(path.join(folderPath, fileName), body, 'utf8');

  const movedMediaPath = path.join(folderPath, path.basename(options.sourcePath));
  try {
    await replaceFile(options.sourcePath, movedMediaPath);
  } catch (error) {
    // Only a cross-device move cannot rename; that one is copied and the original removed.
    // Any other failure — on Windows, typically the file being open in a player — is not a
    // reason to write a second multi-gigabyte copy and then fail to delete the first. The
    // folder goes with the failure so nothing half-made is left beside the source.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      await rm(folderPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await copyFile(options.sourcePath, movedMediaPath);
    await unlink(options.sourcePath).catch(() => {});
  }

  return { folderPath, movedMediaPath };
}
