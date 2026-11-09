import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RestitchScreenDownloader,
  RestitchScreenDownloadError
} from '../apps/agent/src/team-bridge/restitch-screen-download';
import type { ProtectedScreenCacheBinding } from '../apps/agent/src/team-bridge/screen-cache';
import { removeTemporaryDirectory } from './support/temp-dir';
import { TeamScreenCache } from '../apps/agent/src/team-bridge/screen-cache';
import { readRestitchSelectionRange } from '../supabase/functions/drive-ops/restitch-range-reader';
import {
  createScreenSelectionBudget,
  selectScreenCandidate,
  reserveScreenTransfer,
  settleScreenTransfer
} from '@video-compressor/shared';
import { restitchFixturePath } from './fixtures/restitch-images';
const id = (n: number) => 'b1650000-0000-4000-8000-' + String(n).padStart(12, '0');
const endpoint = 'http://127.0.0.1:54321/functions/v1/drive-transfer/restitch/screen-range';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'protected-screen-reader-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeTemporaryDirectory(root);
});
function fixture(bytes = Buffer.from('image test bytes')) {
  const scope: ProtectedScreenCacheBinding = {
    selectionProtocol: 1,
    rootOperationId: id(1),
    teamId: id(2),
    actorId: id(3),
    poolNamespaceId: id(4),
    executorId: id(5),
    epoch: 1,
    nativeInstanceId: id(6),
    versionId: id(7),
    acquisition: 0,
    slot: 'end',
    materialId: id(8),
    checksum: createHash('md5').update(bytes).digest('hex'),
    mimeType: 'image/png',
    sizeBytes: bytes.length
  };
  const reserve = vi.fn(async (binding: Readonly<ProtectedScreenCacheBinding>, offset: number) => ({
    purpose: 'restitch_screen_range_v1',
    requestId: id(10 + offset),
    grantId: id(11 + offset),
    ticket: 't'.repeat(43),
    expiresAt: '2026-11-07T00:00:00Z',
    binding,
    offset,
    bytes: Math.min(2 * 1024 * 1024, bytes.length - offset)
  }));
  let offset = 0;
  const response = (
    body: BodyInit | ReadableStream<Uint8Array> = bytes,
    start = 0,
    length = bytes.length
  ) =>
    new Response(body, {
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-length': String(length),
        'content-range': `bytes ${start}-${start + length - 1}/${bytes.length}`,
        'x-restitch-request-id': id(10 + start)
      }
    });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const start = offset,
      length = Math.min(2 * 1024 * 1024, bytes.length - offset);
    offset += length;
    return response(bytes.subarray(start, start + length), start, length);
  });
  const make = (url = endpoint) =>
    new RestitchScreenDownloader({
      endpoint: url,
      authority: { reserve },
      fetchImpl,
      temporaryRoot: root
    });
  return { scope, reserve, fetchImpl, make, response, bytes };
}
it('writes and hashes actual two-MiB ranges plus a tail with dedicated one-use tickets', async () => {
  const f = fixture(Buffer.alloc(2 * 1024 * 1024 + 13, 71));
  const result = await f.make().download(f.scope, new AbortController().signal);
  expect((await readFile(result.file)).equals(f.bytes)).toBe(true);
  expect(result.sourceChecksum).toBe(f.scope.checksum);
  expect(f.reserve.mock.calls.map(call => call[1])).toEqual([0, 2 * 1024 * 1024]);
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  expect(f.fetchImpl.mock.calls[0]![1]).toMatchObject({
    redirect: 'error',
    headers: { 'x-restitch-screen-ticket': 't'.repeat(43) }
  });
  expect(Object.isFrozen(f.reserve.mock.calls[0]![0])).toBe(true);
  await result.cleanup();
  expect(await readdir(root)).toEqual([]);
});
it.each(['purpose', 'requestId', 'grantId', 'ticket', 'expiresAt', 'binding', 'offset', 'bytes'])(
  'rejects a malformed %s permit before HTTP',
  async key => {
    const f = fixture(),
      original = f.reserve.getMockImplementation()!;
    f.reserve.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      [key]: 'invalid'
    }));
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
      'INVALID_RESPONSE'
    );
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  }
);
it('rejects a substituted root or acquisition before HTTP', async () => {
  const f = fixture(),
    original = f.reserve.getMockImplementation()!;
  f.reserve.mockImplementation(async (...args) => ({
    ...(await original(...args)),
    binding: { ...f.scope, rootOperationId: id(99) }
  }));
  await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
    'INVALID_RESPONSE'
  );
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it.each(['content-range', 'content-length', 'content-type', 'x-restitch-request-id'])(
  'rejects mismatched %s without retry or another grant',
  async header => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => {
      const response = f.response();
      response.headers.set(header, 'wrong');
      return response;
    });
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
      'INVALID_RESPONSE'
    );
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  }
);
it.each(['short', 'oversized', 'changed'] as const)(
  'refuses %s bytes and cleans partial output',
  async mode => {
    const f = fixture();
    const body =
      mode === 'short'
        ? f.bytes.subarray(1)
        : mode === 'oversized'
          ? Buffer.concat([f.bytes, Buffer.from('x')])
          : Buffer.alloc(f.bytes.length, 0);
    f.fetchImpl.mockResolvedValueOnce(f.response(body));
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
      mode === 'changed' ? 'SOURCE_CHANGED' : 'INVALID_RESPONSE'
    );
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  }
);
it('retains only the original opaque request on network failure; never retries consumed permission', async () => {
  const f = fixture();
  f.fetchImpl.mockRejectedValueOnce(Error('provider-secret-url-and-content'));
  const error = await f
    .make()
    .download(f.scope, new AbortController().signal)
    .catch(error => error);
  expect(error).toBeInstanceOf(RestitchScreenDownloadError);
  expect(error.requestId).toBe(id(10));
  expect(JSON.stringify(error)).not.toContain('provider-secret');
  expect(error.message).toBe('RESTITCH_SCREEN_FETCH_FAILED');
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toEqual([]);
});
it('waits for the original stream cancellation before reporting quiescence or cleaning output', async () => {
  const f = fixture(),
    controller = new AbortController();
  let finishCancel!: () => void, beginCancel!: () => void;
  const cancelStarted = new Promise<void>(resolve => {
    beginCancel = resolve;
  });
  const cancelDone = new Promise<void>(resolve => {
    finishCancel = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(Buffer.concat([f.bytes, Buffer.from('too many')]));
    },
    async cancel() {
      beginCancel();
      await cancelDone;
    }
  });
  f.fetchImpl.mockResolvedValueOnce(f.response(body));
  let settled = false;
  const pending = f
    .make()
    .download(f.scope, controller.signal)
    .catch(error => {
      settled = true;
      return error;
    });
  await cancelStarted;
  controller.abort();
  expect(settled).toBe(false);
  expect(await readdir(root)).toHaveLength(1);
  finishCancel();
  expect((await pending).message).toBe('INVALID_RESPONSE');
  expect(await readdir(root)).toEqual([]);
});
it('keeps failed stream cancellation explicitly uncertain', async () => {
  const f = fixture();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(Buffer.concat([f.bytes, Buffer.from('x')]));
    },
    cancel() {
      throw Error('unsafe provider payload');
    }
  });
  f.fetchImpl.mockResolvedValueOnce(f.response(body));
  await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
    'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  );
  expect(f.reserve).toHaveBeenCalledTimes(1);
});
it.each([
  'https://user:secret@example.test',
  'http://example.test',
  'https://example.test/path?ticket=secret'
])('rejects untrusted endpoint configuration', url => {
  const f = fixture();
  expect(() => f.make(url)).toThrow('INVALID_INPUT');
});
it('does not issue a ticket or create a workspace after pre-cancellation', async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(f.make().download(f.scope, controller.signal)).rejects.toThrow('PROCESS_CANCELED');
  expect(f.reserve).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it.each(['PERMISSION_DENIED', 'SOURCE_CHANGED', 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'])(
  'preserves the closed authority reason %s without fetching or drawing again',
  async reason => {
    const f = fixture();
    f.reserve.mockRejectedValueOnce(Error(reason));
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(reason);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  }
);
it('keeps an unknown issue acknowledgement held rather than reporting a defective image', async () => {
  const f = fixture();
  f.reserve.mockRejectedValueOnce(Error('private provider body'));
  await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toThrow(
    'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  );
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it('sanitizes local workspace failures before any authority call', async () => {
  const f = fixture(),
    localFile = path.join(root, 'private-local-name');
  await writeFile(localFile, 'not a directory');
  const downloader = new RestitchScreenDownloader({
    endpoint,
    authority: { reserve: f.reserve },
    temporaryRoot: localFile
  });
  const error = await downloader
    .download(f.scope, new AbortController().signal)
    .catch(error => error);
  expect(error.message).toBe('RESTITCH_SCREEN_FETCH_FAILED');
  expect(String(error)).not.toContain('private-local-name');
  expect(f.reserve).not.toHaveBeenCalled();
});

it.each(['EXPIRED', 'PERMISSION_DENIED', 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'] as const)(
  'preserves the bounded structured service refusal %s without retry',
  async code => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code, retryable: false } }), {
        status: 409,
        headers: { 'content-type': 'application/json' }
      })
    );
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toMatchObject({
      code,
      requestId: id(10)
    });
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  }
);
it.each([false, true])(
  'requires original request correlation before classifying a missing file: %s',
  async correlated => {
    const f = fixture();
    const headers = new Headers({ 'content-type': 'application/json' });
    if (correlated) headers.set('x-restitch-request-id', id(10));
    f.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', retryable: false } }), {
        status: 404,
        headers
      })
    );
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toMatchObject({
      code: correlated ? 'NOT_FOUND' : 'INVALID_RESPONSE'
    });
  }
);
it.each(['oversized', 'invalid_json', 'unknown_code', 'wrong_type'] as const)(
  'refuses the %s failure body without exposing its content',
  async scenario => {
    const f = fixture();
    const body =
      scenario === 'oversized'
        ? 'x'.repeat(8193)
        : scenario === 'invalid_json'
          ? 'PRIVATE_PROVIDER_BODY'
          : JSON.stringify({
              ok: false,
              error: {
                code: scenario === 'unknown_code' ? 'PRIVATE_PROVIDER_BODY' : 'EXPIRED',
                retryable: false
              }
            });
    f.fetchImpl.mockResolvedValueOnce(
      new Response(body, {
        status: 502,
        headers: { 'content-type': scenario === 'wrong_type' ? 'text/plain' : 'application/json' }
      })
    );
    const error = await f
      .make()
      .download(f.scope, new AbortController().signal)
      .catch(error => error);
    expect(error.code).toBe('INVALID_RESPONSE');
    expect(String(error)).not.toContain('PRIVATE_PROVIDER_BODY');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  }
);

it('joins the actual metered reader, native file validation and protected cache without a second reservation', async () => {
  const bytes = await readFile(restitchFixturePath('plain.png')),
    f = fixture(bytes);
  let state = selectScreenCandidate(createScreenSelectionBudget(), f.scope.versionId, bytes.length);
  let issued: ReturnType<typeof reserveScreenTransfer> | undefined;
  const reserve = vi.fn(async (binding: Readonly<ProtectedScreenCacheBinding>, offset: number) => {
    issued = reserveScreenTransfer(state, binding.versionId, id(10 + offset), offset);
    state = issued.state;
    return {
      purpose: 'restitch_screen_range_v1',
      requestId: issued.reservation.requestId,
      grantId: id(11 + offset),
      ticket: 't'.repeat(43),
      expiresAt: '2026-11-07T00:00:00Z',
      binding,
      offset,
      bytes: issued.reservation.bytesReserved
    };
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const original = issued!.reservation;
    return readRestitchSelectionRange(
      {
        store: {
          reserve: async (version, request, offset, acquisition) => {
            expect([version, request, offset, acquisition]).toEqual([
              original.candidateVersionId,
              original.requestId,
              original.offset,
              original.acquisition
            ]);
            return { kind: 'dispatch', reservation: original };
          },
          settle: async (request, measurement) => {
            state = settleScreenTransfer(state, request, measurement);
          }
        },
        versionId: f.scope.versionId,
        requestId: original.requestId,
        acquisition: 0,
        offset: 0,
        sourceFileId: 'synthetic-screen',
        sourceBytes: bytes.length,
        mimeType: 'image/png'
      },
      {
        fetch: async () =>
          new Response(bytes, {
            status: 206,
            headers: {
              'content-length': String(bytes.length),
              'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`
            }
          }),
        open: (io, range) =>
          io.fetchPayload('https://www.googleapis.com/drive/v3/files/synthetic-screen?alt=media', {
            headers: { range: `bytes=${range.start}-${range.end}` }
          })
      }
    );
  });
  const downloader = new RestitchScreenDownloader({
    endpoint,
    authority: { reserve },
    fetchImpl,
    temporaryRoot: root
  });
  const decode = vi.fn(async () => {
    expect(state.transfers).toHaveLength(1);
    expect(state.transfers[0]?.settlement).toMatchObject({ bytes: bytes.length, complete: true });
    return true;
  });
  const cache = new TeamScreenCache(
    {
      transfer: {
        downloadSource: async () => {
          throw Error('GENERIC_FORBIDDEN');
        }
      },
      decode
    },
    path.join(root, 'cache')
  );
  const result = await cache.resolveProtected(
    f.scope,
    {
      authorize: async binding => ({ ...binding }),
      download: downloader.download.bind(downloader)
    },
    new AbortController().signal
  );
  expect(await readFile(result.path)).toEqual(bytes);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalled();
  expect((await readdir(root)).filter(name => name.startsWith('soty-restitch-screen-'))).toEqual(
    []
  );
});

// A committed reservation can lose its reply before any HTTP request starts.
it.each([0, 2 * 1024 * 1024])(
  'retains the original uncertain reservation identity at offset %s without another grant',
  async offset => {
    const f = fixture(Buffer.alloc(2 * 1024 * 1024 + 13, 71));
    const original = f.reserve.getMockImplementation()!;
    f.reserve.mockImplementation(async (...args) => {
      if (args[1] === offset)
        throw new RestitchScreenDownloadError(
          'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
          id(90).toUpperCase()
        );
      return original(...args);
    });
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
      requestId: id(90)
    });
    expect(f.reserve).toHaveBeenCalledTimes(offset === 0 ? 1 : 2);
    expect(f.fetchImpl).toHaveBeenCalledTimes(offset === 0 ? 0 : 1);
    expect(await readdir(root)).toEqual([]);
  }
);
it.each(['https://private.example/token', 'not-a-request', null])(
  'does not forward malformed reservation identity %s',
  async requestId => {
    const f = fixture();
    f.reserve.mockRejectedValueOnce(
      new RestitchScreenDownloadError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN', requestId)
    );
    await expect(f.make().download(f.scope, new AbortController().signal)).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
      requestId: null
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  }
);
