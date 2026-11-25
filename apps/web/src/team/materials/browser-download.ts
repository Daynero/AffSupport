/**
 * The browser's half of a download (073).
 *
 * The bytes are fetched and saved from a same-origin blob. An anchor with `download` that points
 * at another origin is only a hint: Safari ignores it and opens the file — a video in a new tab
 * that starts playing — so a creative saved that way was a tab per click (owner, 2026-11-25).
 */

export async function fetchForDownload(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  } catch (cause) {
    throw new Error('DRIVE_UNAVAILABLE', { cause });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'DRIVE_UNAVAILABLE'
    );
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    type: response.headers.get('content-type') ?? 'application/octet-stream'
  };
}

/** Saves bytes under a name; same-origin, no new tab, nothing left in the document. */
export function saveBytesAsDownload(bytes: Uint8Array, fileName: string, type: string): void {
  const blobUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  try {
    handoffBrowserDownload(blobUrl, fileName);
  } finally {
    // The click starts the save synchronously; a minute is generous for the browser to read it.
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

/**
 * Clicks a detached anchor that saves `url` under `fileName`. Never `target="_blank"`: for a blob
 * it is pointless, and for a response that says `attachment` there is no navigation to keep the
 * workspace from — while a browser that does navigate (Safari, another origin) would open a tab.
 */
export function handoffBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener noreferrer';
  anchor.click();
}
