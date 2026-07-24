import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelDownloader } from '../apps/agent/src/whisper/downloader.js';

const bytes = Buffer.from('verified local model fixture');
const digest = createHash('sha256').update(bytes).digest('hex');

describe('ModelDownloader', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wishly-model-'));
    target = path.join(dir, 'model.bin');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  function downloader(
    overrides: Partial<{ sha256: string; sizeBytes: number }> = {},
    finalize?: (file: string) => Promise<void>
  ) {
    return new ModelDownloader(
      {
        label: 'fixture',
        url: 'https://models.invalid/fixture',
        sha256: overrides.sha256 ?? digest,
        sizeBytes: overrides.sizeBytes ?? bytes.length
      },
      () => target,
      () => existsSync(target),
      () => {},
      () => {},
      finalize
    );
  }

  it('streams to .part, verifies SHA-256, and atomically installs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(bytes)))
    );
    const value = downloader();
    await value.start('composite-install');
    expect(await readFile(target)).toEqual(bytes);
    expect(existsSync(`${target}.part`)).toBe(false);
    expect(value.status()).toMatchObject({
      present: true,
      progress: 100,
      downloadBatchId: 'composite-install',
      error: null
    });
  });

  it('does not fetch an artifact that is already present', async () => {
    await writeFile(target, bytes);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await downloader().start();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a checksum mismatch and leaves no target or partial', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(bytes)))
    );
    const value = downloader({ sha256: '0'.repeat(64) });
    await value.start();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.part`)).toBe(false);
    expect(value.status().error).toContain('integrity');
  });

  it('supports cancel followed by a clean retry', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        attempt += 1;
        if (attempt > 1) return new Response(new Uint8Array(bytes));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 4));
            const abort = () => controller.error(new DOMException('Aborted', 'AbortError'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          }
        });
        return new Response(stream, {
          headers: { 'content-length': String(bytes.length) }
        });
      })
    );
    const value = downloader();
    const first = value.start();
    await vi.waitFor(() => expect(attempt).toBe(1));
    value.cancel();
    await first;
    expect(value.status()).toMatchObject({ present: false, downloading: false, error: null });
    expect(existsSync(`${target}.part`)).toBe(false);

    await value.start();
    expect(value.status()).toMatchObject({ present: true, progress: 100, error: null });
  });

  it('resumes a preserved partial with an HTTP Range request', async () => {
    const split = 9;
    const ranges: Array<string | undefined> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
      const offset = Number(/^bytes=(\d+)-$/u.exec(ranges.at(-1) ?? '')?.[1] ?? 0);
      return new Response(new Uint8Array(bytes.subarray(offset)), {
        status: 206,
        headers: {
          'content-length': String(bytes.length - offset),
          'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    await writeFile(`${target}.part`, bytes.subarray(0, split));

    const value = downloader();
    await value.start();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ranges[0]).toBe(`bytes=${split}-`);
    expect(await readFile(target)).toEqual(bytes);
    expect(value.status()).toMatchObject({ present: true, progress: 100, error: null });
  });

  it('reports preserved resumable bytes immediately after a process restart', async () => {
    const split = 9;
    await writeFile(`${target}.part`, bytes.subarray(0, split));
    expect(downloader().status()).toMatchObject({
      present: false,
      downloadedBytes: split,
      progress: Math.floor((split / bytes.length) * 100)
    });
  });

  it('automatically reconnects after a transient network failure', async () => {
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('terminated');
      return new Response(new Uint8Array(bytes));
    });
    vi.stubGlobal('fetch', fetch);
    const value = downloader();
    await value.start();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(target)).toEqual(bytes);
  });

  it('runs the post-verification installer before reporting ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(bytes)))
    );
    let finalized = '';
    const value = downloader({}, async file => {
      finalized = file;
    });
    await value.start();
    expect(finalized).toBe(target);
    expect(value.status().present).toBe(true);
  });
});
