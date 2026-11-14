import { describe, expect, it, vi } from 'vitest';
import { readArchiveRange } from '../supabase/functions/_shared/archive-inspection';
import { MAX_THUMBNAIL_BYTES, readThumbnailBytes } from '../supabase/functions/_shared/thumbnails';
import { runPreviewWarmSlice } from '../supabase/functions/_shared/preview-warm';

function response(chunks: Uint8Array[], init: ResponseInit = {}) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]!);
    else controller.close();
  });
  return {
    reply: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), init),
    pull,
    cancel
  };
}

describe('archive inspection provider boundary', () => {
  it('rejects an ignored tail range without downloading the full archive', async () => {
    const { reply, pull, cancel } = response([new Uint8Array(1000)]);
    expect(await readArchiveRange(reply, 990, 999, 1000)).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['bytes 0-9/1000', 'bytes 990-999/1001', 'bytes 990-999/*', ''])(
    'refuses a wrong offset or changed file size: %s',
    async contentRange => {
      const { reply, pull, cancel } = response([new Uint8Array(10)], {
        status: 206,
        headers: { 'content-range': contentRange }
      });
      expect(await readArchiveRange(reply, 990, 999, 1000)).toBeNull();
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it('accepts an exact partial response and a complete small file', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    expect(
      await readArchiveRange(
        new Response(bytes, {
          status: 206,
          headers: { 'content-range': 'bytes 7-9/10' }
        }),
        7,
        9,
        10
      )
    ).toEqual(bytes);
    expect(await readArchiveRange(new Response(bytes), 0, 2, 3)).toEqual(bytes);
  });

  it('cuts off an oversized range even when its headers claim the correct size', async () => {
    const { reply, pull, cancel } = response(
      [new Uint8Array(3), new Uint8Array(1), new Uint8Array(1000)],
      { status: 206, headers: { 'content-range': 'bytes 7-9/10', 'content-length': '3' } }
    );
    expect(await readArchiveRange(reply, 7, 9, 10)).toBeNull();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not interpret a truncated range as a complete ZIP directory', async () => {
    expect(
      await readArchiveRange(
        new Response(new Uint8Array(2), {
          status: 206,
          headers: { 'content-range': 'bytes 7-9/10' }
        }),
        7,
        9,
        10
      )
    ).toBeNull();
  });
});

describe('thumbnail provider boundary', () => {
  it.each([new Headers(), new Headers({ 'content-length': '1' })])(
    'stops at the byte cap with headers %o',
    async headers => {
      const { reply, pull, cancel } = response(
        [new Uint8Array(MAX_THUMBNAIL_BYTES), new Uint8Array(1), new Uint8Array(100)],
        { headers }
      );
      await expect(readThumbnailBytes(reply)).rejects.toMatchObject({ code: 'TOO_LARGE' });
      expect(pull).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it('accepts a bounded chunked thumbnail and rejects a truncated declared body', async () => {
    expect(await readThumbnailBytes(new Response(Uint8Array.of(1, 2)))).toEqual(
      Uint8Array.of(1, 2)
    );
    await expect(
      readThumbnailBytes(
        new Response(Uint8Array.of(1), {
          headers: { 'content-length': '2' }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('records an oversized preview as too_large without storing or retrying its bytes', async () => {
    const commit = vi.fn();
    const store = vi.fn();
    const row = {
      materialId: 'm',
      teamId: 't',
      connectionId: 'c',
      credentialId: 'k',
      driveFileId: 'f',
      resourceKey: null,
      driveVersion: 'v1',
      mimeType: 'image/png'
    };
    const result = await runPreviewWarmSlice([row], {
      getFile: async () => ({
        trashed: false,
        mimeType: 'image/png',
        version: 'v1',
        checksum: null,
        thumbnailLink: 'https://example.test/t'
      }),
      fetchThumbnail: async () => ({
        status: 200,
        mimeType: 'image/png',
        bytes: await readThumbnailBytes(response([new Uint8Array(MAX_THUMBNAIL_BYTES + 1)]).reply)
      }),
      store,
      commit
    });
    expect(result).toMatchObject({ unavailable: 1, deferred: 0 });
    expect(commit).toHaveBeenCalledWith(row, { state: 'unavailable', reason: 'too_large' });
    expect(store).not.toHaveBeenCalled();
  });
});
