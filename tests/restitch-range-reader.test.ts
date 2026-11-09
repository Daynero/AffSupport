import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { refreshGoogleAccessToken } from '../supabase/functions/_shared/credentials';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ScreenTransferMeasurement,
  ScreenTransferReservation
} from '@video-compressor/shared';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import { readRestitchSelectionRange } from '../supabase/functions/drive-ops/restitch-range-reader';
const id = (n: number) => 'b1560000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture(parts = ['ABCD']) {
  let time = 0;
  const reservation: ScreenTransferReservation = {
    requestId: id(1),
    candidateVersionId: id(2),
    acquisition: 0,
    offset: 0,
    bytesReserved: 4,
    ioMsReserved: 120000,
    retry: false,
    settlement: null
  };
  const store = {
    reserve: vi.fn(
      async (_version: string, _request: string, _offset: number, _acquisition: number) => ({
        kind: 'dispatch' as 'dispatch' | 'readback',
        reservation
      })
    ),
    settle: vi.fn(async (_request: string, _measurement: ScreenTransferMeasurement) => {})
  };
  const response = () => {
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            time += 7;
            const part = parts[index++];
            if (part === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(part));
          }
        },
        { highWaterMark: 0 }
      ),
      { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' } }
    );
  };
  const fetcher = vi.fn<typeof fetch>(async () => {
    time += 5;
    return response();
  });
  const input = {
    store,
    versionId: id(2),
    requestId: id(1),
    acquisition: 0,
    offset: 0,
    sourceFileId: 'synthetic-image',
    sourceBytes: 4,
    mimeType: 'image/png' as const
  };
  const deps: Parameters<typeof readRestitchSelectionRange>[1] = {
    fetch: fetcher,
    now: () => time,
    open: async (io, range) =>
      io.fetchPayload('https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media', {
        headers: { range: 'bytes=' + range.start + '-' + range.end }
      })
  };
  return {
    store,
    input,
    deps,
    fetcher,
    response,
    advance: (ms: number) => {
      time += ms;
    }
  };
}
afterEach(() => vi.useRealTimers());
it('reserves the original acquisition before fetching and settles before returning any bytes', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async () => {
    expect(f.store.reserve).toHaveBeenCalledExactlyOnceWith(id(2), id(1), 0, 0);
    f.advance(5);
    return f.response();
  });
  let release!: () => void;
  f.store.settle.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      })
  );
  let delivered = false;
  const pending = readRestitchSelectionRange(f.input, f.deps).then(response => {
    delivered = true;
    return response;
  });
  await vi.waitFor(() => expect(f.store.settle).toHaveBeenCalledOnce());
  expect(delivered).toBe(false);
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 4, ioMs: 19, complete: true });
  release();
  const response = await pending;
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 0-3/4');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-restitch-request-id')).toBe(id(1));
  expect(await response.text()).toBe('ABCD');
});
it('never opens an upstream request on readback or lost reservation acknowledgement', async () => {
  const f = fixture();
  f.store.reserve.mockResolvedValue({
    kind: 'readback',
    reservation: {
      requestId: id(1),
      candidateVersionId: id(2),
      acquisition: 0,
      offset: 0,
      bytesReserved: 4,
      ioMsReserved: 120000,
      retry: false,
      settlement: null
    }
  });
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  f.store.reserve.mockRejectedValue(new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.store.settle).not.toHaveBeenCalled();
});
it('accounts metadata waits while excluding work between upstream operations and settlement latency', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async input => {
    f.advance(5);
    return String(input).endsWith('/metadata') ? new Response('{"ok":true}') : f.response();
  });
  f.deps.open = async (io, range) => {
    const metadata = await io.fetch('https://provider.invalid/metadata');
    await metadata.json();
    f.advance(1000);
    const response = await io.fetchPayload(
      'https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media',
      {
        headers: { range: 'bytes=' + range.start + '-' + range.end }
      }
    );
    f.advance(500);
    return response;
  };
  f.store.settle.mockImplementation(async () => {
    f.advance(4000);
  });
  expect(await (await readRestitchSelectionRange(f.input, f.deps)).text()).toBe('ABCD');
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 4, ioMs: 24, complete: true });
});
it('accounts a truncated prefix without releasing partial bytes or claiming complete acquisition', async () => {
  const f = fixture(['AB']);
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'DRIVE_UNAVAILABLE'
  });
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 2, ioMs: 19, complete: false });
});
it('keeps an observed overrun held rather than clamping it into a successful measurement', async () => {
  const f = fixture(['ABCDE']);
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.store.settle).not.toHaveBeenCalled();
});
it('refuses a response outside the measured transport instead of trusting supplied counters', async () => {
  const f = fixture();
  f.deps.open = async () => f.response();
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.store.settle).not.toHaveBeenCalled();
});
it('does not create a permit when already canceled, and closes an acknowledged unused permit if cancellation wins afterward', async () => {
  const f = fixture();
  const before = new AbortController();
  before.abort();
  await expect(
    readRestitchSelectionRange({ ...f.input, signal: before.signal }, f.deps)
  ).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(f.store.reserve).not.toHaveBeenCalled();
  const after = new AbortController();
  const permit = await f.store.reserve(id(2), id(1), 0, 0);
  f.store.reserve.mockClear();
  f.store.reserve.mockImplementation(async () => {
    after.abort();
    return permit;
  });
  await expect(
    readRestitchSelectionRange({ ...f.input, signal: after.signal }, f.deps)
  ).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 0, ioMs: 0, complete: false });
});
it('does not deliver a buffered range when cancellation arrives during bookkeeping', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.store.settle.mockImplementation(async () => {
    controller.abort();
  });
  await expect(
    readRestitchSelectionRange({ ...f.input, signal: controller.signal }, f.deps)
  ).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 4, ioMs: 19, complete: true });
});
it('does not deliver a buffered range without confirmed bookkeeping', async () => {
  const f = fixture();
  f.store.settle.mockRejectedValue(new TeamFunctionError('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it('keeps the permit unconfirmed when an upstream body cannot be quiesced', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) }, { highWaterMark: 0 }),
      { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 1-4/5' } }
    )
  );
  const result = readRestitchSelectionRange(f.input, f.deps).then(
    () => null,
    error => error as TeamFunctionError
  );
  await vi.advanceTimersByTimeAsync(6000);
  expect(await result).toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.store.settle).not.toHaveBeenCalled();
});

it('accounts a canceled active read as a known prefix rather than a leaked or falsely unknown range', async () => {
  const f = fixture();
  const controller = new AbortController();
  let waiting = false;
  f.fetcher.mockImplementation(async (_input, init) => {
    f.advance(5);
    let first = true;
    const body = new ReadableStream<Uint8Array>(
      {
        start(source) {
          init?.signal?.addEventListener(
            'abort',
            () => source.error(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        },
        pull(source) {
          if (first) {
            first = false;
            f.advance(7);
            source.enqueue(new TextEncoder().encode('AB'));
            return;
          }
          waiting = true;
          return new Promise<void>(() => {});
        }
      },
      { highWaterMark: 0 }
    );
    return new Response(body, {
      status: 206,
      headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' }
    });
  });
  const result = readRestitchSelectionRange({ ...f.input, signal: controller.signal }, f.deps).then(
    () => null,
    error => error as TeamFunctionError
  );
  await vi.waitFor(() => expect(waiting).toBe(true));
  f.advance(11);
  controller.abort();
  expect(await result).toMatchObject({ code: 'PROCESS_CANCELED' });
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 2, ioMs: 23, complete: false });
});

it.each([4, 5])(
  'meters the existing OAuth and Drive client chain with source size %s',
  async size => {
    const f = fixture();
    f.fetcher.mockImplementation(async input => {
      f.advance(5);
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com')
        return new Response(
          JSON.stringify({ access_token: 'SYNTHETIC_ACCESS_TOKEN_047', expires_in: 3600 })
        );
      if (url.searchParams.get('alt') === 'media') return f.response();
      return new Response(
        JSON.stringify({
          id: 'synthetic-image',
          name: 'Synthetic.png',
          mimeType: 'image/png',
          size: String(size),
          version: '1',
          md5Checksum: 'a'.repeat(32),
          parents: ['root'],
          trashed: false,
          capabilities: { canDownload: true }
        })
      );
    });
    f.deps.open = async (io, range) => {
      const token = await refreshGoogleAccessToken({
        credential: {
          credentialId: id(3),
          connectedBy: id(4),
          googlePermissionId: 'synthetic-permission',
          googleAccountEmail: 'fixture@selection.invalid',
          scope: 'https://www.googleapis.com/auth/drive.file',
          refreshToken: 'SYNTHETIC_REFRESH_TOKEN'
        },
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        oauthMode: 'testing',
        productionSignals: {
          siteUrl: 'http://127.0.0.1:5175',
          requestOrigin: 'http://127.0.0.1:5175'
        },
        fetchImpl: io.fetch
      });
      const client = new GoogleDriveClient(token.accessToken, io.fetch);
      const metadata = await client.getFile('synthetic-image');
      if (metadata.size !== f.input.sourceBytes) throw new TeamFunctionError('SOURCE_CHANGED');
      return new GoogleDriveClient(token.accessToken, io.fetchPayload).fetchFileRange({
        fileId: metadata.id,
        ...range,
        signal: io.signal
      });
    };
    const result = readRestitchSelectionRange(f.input, f.deps);
    if (size === 4) {
      expect(await (await result).text()).toBe('ABCD');
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 4, ioMs: 29, complete: true });
      expect(new Headers(f.fetcher.mock.calls[2][1]?.headers).get('range')).toBe('bytes=0-3');
    } else {
      await expect(result).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 0, ioMs: 10, complete: false });
    }
  }
);
it('best-effort closes an unmetered response while retaining uncertain accounting', async () => {
  const f = fixture();
  const close = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({ cancel: close }, { highWaterMark: 0 }),
    { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 0-3/4' } }
  );
  f.deps.open = async () => response;
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(close).toHaveBeenCalledOnce();
  expect(f.store.settle).not.toHaveBeenCalled();
});
it('does not turn a clock rollback between upstream waits into confirmed accounting', async () => {
  const f = fixture();
  const open = f.deps.open;
  f.deps.open = async (io, range) => {
    const response = await open(io, range);
    f.advance(-1000);
    return response;
  };
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.store.settle).not.toHaveBeenCalled();
});
it('keeps an unquiesced header request held after its active IO deadline', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.deps.now = () => Date.now();
  f.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
  const result = readRestitchSelectionRange(f.input, f.deps).then(
    () => null,
    error => error as TeamFunctionError
  );
  await vi.advanceTimersByTimeAsync(126000);
  expect(await result).toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.store.settle).not.toHaveBeenCalled();
});

it('never releases a control response as image bytes even when its dimensions match', async () => {
  const f = fixture();
  f.deps.open = io =>
    io.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: 'SYNTHETIC_PRIVATE_CONTROL_REQUEST'
    });
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.store.settle).not.toHaveBeenCalled();
});

it.each([
  ['https://attacker.invalid/drive/v3/files/synthetic-image?alt=media', {}],
  ['https://www.googleapis.com/drive/v3/files/another-image?alt=media', {}],
  ['https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media#fragment', {}],
  ['https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media&alt=media', {}],
  [
    'https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media',
    { method: 'POST', body: 'private' }
  ],
  [
    'https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media',
    { headers: { range: 'bytes=0-999' } }
  ]
])('does not send the reserved range to an unrelated payload target %s', async (url, init) => {
  const f = fixture();
  f.deps.open = io => io.fetchPayload(url, { headers: { range: 'bytes=0-3' }, ...init });
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.store.settle).toHaveBeenCalledWith(id(1), { bytes: 0, ioMs: 0, complete: false });
});

it('does not dispatch two payload requests under one range reservation', async () => {
  const f = fixture();
  f.deps.open = async (io, range) => {
    const init = { headers: { range: 'bytes=' + range.start + '-' + range.end } };
    const url = 'https://www.googleapis.com/drive/v3/files/synthetic-image?alt=media';
    await io.fetchPayload(url, init);
    return io.fetchPayload(url, init);
  };
  await expect(readRestitchSelectionRange(f.input, f.deps)).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.store.settle).not.toHaveBeenCalled();
});

it('observes cancellation that occurs inside fetch before its abort listener is installed', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const controller = new AbortController();
  f.fetcher.mockImplementation(() => {
    controller.abort();
    return new Promise<Response>(() => {});
  });
  let outcome: string | undefined;
  void readRestitchSelectionRange({ ...f.input, signal: controller.signal }, f.deps).then(
    () => {
      outcome = 'unexpected_success';
    },
    (error: TeamFunctionError) => {
      outcome = error.code;
    }
  );
  await vi.advanceTimersByTimeAsync(6000);
  expect(outcome).toBe('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN');
  expect(f.store.settle).not.toHaveBeenCalled();
});
