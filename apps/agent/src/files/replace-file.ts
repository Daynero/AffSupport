import { rename } from 'node:fs/promises';
import { currentPlatform } from '../platform/platform.js';

/** What Windows answers while a scanner or backup agent briefly holds the target. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

export interface ReplaceFileOptions {
  platform?: NodeJS.Platform;
  /** Test seams. */
  renameImpl?: typeof rename;
  delay?: (ms: number) => Promise<void>;
}

/**
 * `rename` with the retries Windows needs.
 *
 * Replacing a file that an antivirus scanner or a backup agent has open for a moment fails
 * there with EPERM, EACCES or EBUSY — transient, routine, and gone by the next try. On the
 * other platforms the first attempt is the only one; those codes mean what they say.
 */
export async function replaceFile(
  from: string,
  to: string,
  options: ReplaceFileOptions = {}
): Promise<void> {
  const platform = options.platform ?? currentPlatform();
  const renameImpl = options.renameImpl ?? rename;
  const delay =
    options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const transient = platform === 'win32' && TRANSIENT_CODES.has(code);
      if (!transient || attempt >= RETRY_DELAYS_MS.length) throw error;
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** The `rm` options that ride out the same momentary holds. */
export const REMOVE_WITH_RETRIES = {
  recursive: true,
  force: true,
  maxRetries: 4,
  retryDelay: 100
} as const;
