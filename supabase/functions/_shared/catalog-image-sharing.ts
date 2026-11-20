import type { GoogleDriveClient } from './drive.ts';
import { ensureAnyoneReader } from './link-sharing.ts';
import { TeamFunctionError } from './errors.ts';

type SharingClient = Pick<
  GoogleDriveClient,
  'listAnyonePermissions' | 'createAnyoneReaderPermission'
>;

const PARALLEL = 8;

/**
 * One catalog attempt's image checks. Reuse only within that attempt (for growth followed by
 * refresh), never across credentials, retries or updater rounds. Each permission mutation
 * still includes ensureAnyoneReader's read-back, including durable permission receipts.
 */
export function createCatalogImageSharer(drive: SharingClient) {
  const verified = new Set<string>();
  return async (images: ReadonlyArray<{ driveFileId: string }>): Promise<void> => {
    const queue = [...new Set(images.map(image => image.driveFileId))].filter(
      id => !verified.has(id)
    );
    let failure: { error: unknown } | undefined;
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (!failure) {
        const fileId = queue.shift();
        if (fileId === undefined) return;
        try {
          await ensureAnyoneReader(drive, fileId);
          verified.add(fileId);
        } catch (error) {
          failure ??= { error };
        }
      }
    });
    // A fail-fast Promise.all would let other workers keep changing permissions after
    // the caller records interruption or releases the attempt. Drain every started check.
    await Promise.all(workers);
    if (failure) throw failure.error;
  };
}

/** Pauses between anonymous reads: Drive can take a moment to honour a fresh link grant. */
const ANONYMOUS_READ_WAITS_MS = [1_000, 3_000] as const;
/** A catalog picture Meta will fetch; Drive's own limit for a preview is far above it. */
const ANONYMOUS_IMAGE_MAX_BYTES = 50_000_000;

/**
 * 062 (R33): proves that a signed-out reader gets an image at `url` — no cookies, no
 * redirect to a sign-in page, an `image/*` body of a real length. Used before a creative's
 * link is written to H, for a Drive link and (by callers that hold no bytes) an R2 one.
 * Failure is PUBLIC_READ_UNVERIFIED, which is retryable: a grant may still be settling.
 */
export async function verifyAnonymousImage(
  url: string,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ mime: string; size: number }> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TeamFunctionError('PUBLIC_READ_UNVERIFIED', { retryable: false });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new TeamFunctionError('PUBLIC_READ_UNVERIFIED', { retryable: false });
  for (let round = 0; ; round += 1) {
    const read = await readAnonymously(fetcher, parsed, options.signal);
    if (read) return read;
    if (round >= ANONYMOUS_READ_WAITS_MS.length)
      throw new TeamFunctionError('PUBLIC_READ_UNVERIFIED', { retryable: true });
    await sleep(ANONYMOUS_READ_WAITS_MS[round]!);
  }
}

async function readAnonymously(
  fetcher: typeof fetch,
  url: URL,
  signal: AbortSignal | undefined
): Promise<{ mime: string; size: number } | null> {
  let response: Response;
  try {
    // Drive answers `uc?export=view` with a redirect to its content host; a sign-in page
    // is HTML, so following redirects is safe and the type below decides.
    response = await fetcher(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      ...(signal ? { signal } : {})
    });
  } catch {
    return null;
  }
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!response.ok || !response.body || !mime.startsWith('image/')) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ANONYMOUS_IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return size > 0 ? { mime, size } : null;
}
