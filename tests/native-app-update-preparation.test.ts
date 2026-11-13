import { removeTemporaryDirectory } from './support/temp-dir';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeArchive, nativeUpdateFeed } from '../apps/agent/src/update/preparation';
import { nativeCandidate } from './support/native-app-updates';
afterEach(() => vi.unstubAllGlobals());
describe('bounded native update preparation', () => {
  it('rehashes cache hits and downloads corrupted bytes again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-updater-cache-'));
    const candidate = nativeCandidate();
    candidate.archive.sha256 = createHash('sha256').update('hello').digest('hex');
    const fetcher = vi.fn(
      async () => new Response('hello', { headers: { 'content-length': '5' } })
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const file = await prepareNativeArchive(
        candidate,
        root,
        new AbortController().signal,
        () => {}
      );
      expect(await readFile(file, 'utf8')).toBe('hello');
      await prepareNativeArchive(candidate, root, new AbortController().signal, () => {});
      expect(fetcher).toHaveBeenCalledOnce();
      await writeFile(file, 'wrong');
      await prepareNativeArchive(candidate, root, new AbortController().signal, () => {});
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
  it('rejects a foreign redirect and never writes it as prepared', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'soty-updater-redirect-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://foreign.invalid/update.zip' }
          })
      )
    );
    try {
      await expect(
        prepareNativeArchive(nativeCandidate(), root, new AbortController().signal, () => {})
      ).rejects.toThrow('APP_UPDATE_DOWNLOAD_FAILED');
    } finally {
      await removeTemporaryDirectory(root);
    }
  });
  it.each(['oversized', 'truncated'] as const)(
    'rejects an %s stream and removes its incomplete cache file',
    async kind => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'soty-updater-stream-'));
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(kind === 'oversized' ? '123456' : '1234'));
          if (kind === 'truncated') controller.close();
        },
        cancel
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      );
      try {
        await expect(
          prepareNativeArchive(nativeCandidate(), root, new AbortController().signal, () => {})
        ).rejects.toThrow('APP_UPDATE_DIGEST_MISMATCH');
        expect(body.locked).toBe(false);
        if (kind === 'oversized') expect(cancel).toHaveBeenCalledOnce();
        expect(await readdir(root)).toEqual([]);
      } finally {
        await removeTemporaryDirectory(root);
      }
    }
  );
  it('feeds exactly one signed full archive and never a browser-supplied URL', () => {
    const candidate = nativeCandidate();
    const feed = nativeUpdateFeed(candidate);
    expect(feed.match(/<enclosure /g)).toHaveLength(1);
    expect(feed).toContain(candidate.archive.edSignature);
    expect(feed).toContain('<sparkle:version>999</sparkle:version>');
    expect(feed).not.toContain('deltaFrom');
  });
});
