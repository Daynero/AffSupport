import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamOperationEvents } from '../apps/agent/src/team-bridge/events.js';
import { TeamDownloadBridge } from '../apps/agent/src/team-bridge/download.js';
import {
  TeamProcessBridge,
  type TeamProcessDelegate,
  type TeamProcessTransfer
} from '../apps/agent/src/team-bridge/process.js';
import { TeamTransferClient } from '../apps/agent/src/team-bridge/transfer.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wishly-team-bridge-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => removeTemporaryDirectory(root)));
});

function grant(purpose: 'process_input' | 'finalize' | 'download_range' = 'process_input') {
  return {
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 4,
    maxUses: 8
  } as const;
}

describe('team cloud/local transfer bridge', () => {
  it('hands a large download to a user-chosen folder without overwriting an existing file', async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, 'destination');
    await import('node:fs/promises').then(fs => fs.mkdir(destination));
    await writeFile(path.join(destination, '..-creative.mp4'), 'existing');
    const source = path.join(root, 'source.bin');
    await writeFile(source, 'downloaded');
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const transfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file: source,
        sizeBytes: 10,
        sourceVersion: '1',
        sourceChecksum: null,
        cleanup
      })
    };
    const bridge = new TeamDownloadBridge({
      transfer,
      chooseDestination: vi.fn().mockResolvedValue(destination),
      reveal: vi.fn()
    });

    await expect(
      bridge.download({
        operationId: 'large-download',
        transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        transferGrant: grant('download_range'),
        fileName: '../creative.mp4'
      })
    ).resolves.toEqual({
      saved: true,
      fileName: '..-creative (1).mp4',
      sizeBytes: 10,
      // Where it landed — resolved, since that is the path the file is under —
      // so the caller can offer the same folder next time instead of opening
      // the picker again.
      destination: await realpath(destination)
    });
    expect(await readFile(path.join(destination, '..-creative (1).mp4'), 'utf8')).toBe(
      'downloaded'
    );
    expect(await readFile(path.join(destination, '..-creative.mp4'), 'utf8')).toBe('existing');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('compresses locally (013 B5): a vanished remembered folder asks again, a batch reveals once', async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, 'chosen');
    await import('node:fs/promises').then(fs => fs.mkdir(destination));
    const source = path.join(root, 'source.bin');
    await writeFile(source, 'original');
    const compressed = path.join(root, 'compressed.mp4');
    await writeFile(compressed, 'compressed');
    const transfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file: source,
        sizeBytes: 8,
        sourceVersion: '1',
        sourceChecksum: null,
        cleanup: vi.fn().mockResolvedValue(undefined)
      })
    };
    const delegate = vi.fn<TeamProcessDelegate>().mockResolvedValue({
      file: compressed,
      mimeType: 'video/mp4',
      sizeBytes: 10
    });
    const chooseDestination = vi.fn().mockResolvedValue(destination);
    const reveal = vi.fn();
    const bridge = new TeamDownloadBridge({
      transfer,
      chooseDestination,
      reveal,
      delegates: { compressor: delegate }
    });

    const saved = await bridge.download({
      operationId: 'local-compress',
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      transferGrant: grant('download_range'),
      fileName: 'clip.mov',
      destination: path.join(root, 'moved-away'),
      compress: { embed: false, suffix: '_small' },
      reveal: false
    });

    expect(chooseDestination).toHaveBeenCalledOnce();
    expect(delegate).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    expect(saved).toMatchObject({
      fileName: 'clip_small.mp4',
      destination: await realpath(destination)
    });
    expect(await readFile(path.join(destination, 'clip_small.mp4'), 'utf8')).toBe('compressed');

    // The next file of the batch goes straight to the folder the first one landed in.
    await bridge.download({
      operationId: 'local-compress-2',
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      transferGrant: grant('download_range'),
      fileName: 'clip.mov',
      destination: saved.destination,
      compress: { embed: false, suffix: '_small' }
    });
    expect(chooseDestination).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
    expect(await readdir(destination)).toEqual(['clip_small (1).mp4', 'clip_small.mp4']);
  });

  it('downloads repeated bounded ranges, preserves source identity, and exposes no provider token', async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const range = new Headers(init?.headers).get('range');
      const start = Number(/^bytes=(\d+)-/u.exec(range ?? '')?.[1] ?? 0);
      const end = Math.min(start + 3, 7);
      return new Response(
        new Uint8Array(Array.from({ length: end - start + 1 }, (_, i) => start + i)),
        {
          status: 206,
          headers: {
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/8`,
            'content-type': 'application/octet-stream',
            'x-wishly-source-version': '7',
            'x-wishly-source-checksum': 'checksum-7'
          }
        }
      );
    });
    const client = new TeamTransferClient({ fetchImpl, temporaryRoot: root });
    const downloaded = await client.downloadSource(
      {
        operationId: 'operation-download',
        transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        grant: grant()
      },
      new AbortController().signal
    );

    expect([...new Uint8Array(await readFile(downloaded.file))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(downloaded).toMatchObject({
      sizeBytes: 8,
      sourceVersion: '7',
      sourceChecksum: 'checksum-7'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get('range'))).toEqual(
      ['bytes=0-3', 'bytes=4-7']
    );
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/google.*bearer|refresh_token/i);
    await downloaded.cleanup();
    expect(await readdir(root)).toEqual([]);
  });

  it('fails closed on permission loss or source identity changes and removes partial bytes', async () => {
    const root = await temporaryRoot();
    const permissionLoss = new TeamTransferClient({
      temporaryRoot: root,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: 'PERMISSION_DENIED' } }), { status: 403 })
        )
    });
    await expect(
      permissionLoss.downloadSource(
        {
          operationId: 'operation-denied',
          transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
          grant: grant()
        },
        new AbortController().signal
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(await readdir(root)).toEqual([]);

    const changed = new TeamTransferClient({
      temporaryRoot: root,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Uint8Array(4), {
            status: 206,
            headers: {
              'content-length': '4',
              'content-range': 'bytes 0-3/8',
              'x-wishly-source-version': '1'
            }
          })
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array(4), {
            status: 206,
            headers: {
              'content-length': '4',
              'content-range': 'bytes 4-7/8',
              'x-wishly-source-version': '2'
            }
          })
        )
    });
    await expect(
      changed.downloadSource(
        {
          operationId: 'operation-changed',
          transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
          grant: grant()
        },
        new AbortController().signal
      )
    ).rejects.toThrow('SOURCE_CHANGED');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['recover', 'changed', 'cancelled', 'permanent', 'exhausted', 'exact-budget'] as const)(
    'replays only the interrupted source range without corrupting bytes: %s',
    async mode => {
      const root = await temporaryRoot();
      const controller = new AbortController();
      const requested: string[] = [];
      const progress: number[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        requested.push(new Headers(init?.headers).get('range')!);
        if (mode === 'exhausted') throw new TypeError('terminated');
        if (mode === 'permanent')
          return new Response(
            JSON.stringify({
              error: {
                code: 'DRIVE_UNAVAILABLE',
                retryable: false
              }
            }),
            { status: 503 }
          );
        const first = requested.length === 1;
        if (first && mode === 'cancelled')
          setTimeout(() => controller.abort(new Error('PROCESS_CANCELED')), 10);
        let pulls = 0;
        const body = first
          ? new ReadableStream<Uint8Array>({
              pull(stream) {
                if (pulls++ === 0) stream.enqueue(new TextEncoder().encode('ab'));
                else stream.error(new TypeError('terminated'));
              }
            })
          : new TextEncoder().encode(requested.at(-1) === 'bytes=0-3' ? 'abcd' : 'efgh');
        const start = requested.at(-1) === 'bytes=0-3' ? 0 : 4;
        return new Response(body, {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${start + 3}/8`,
            'content-length': '4',
            'x-wishly-source-version': mode === 'changed' && !first ? 'v2' : 'v1',
            'x-wishly-source-checksum': 'same-source'
          }
        });
      });
      const client = new TeamTransferClient({ fetchImpl, temporaryRoot: root });
      const result = client.downloadSource(
        {
          operationId: 'source-retry',
          transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
          grant: { ...grant(), maxUses: mode === 'exact-budget' ? 2 : 8 },
          onProgress: bytes => progress.push(bytes)
        },
        controller.signal
      );
      if (mode === 'recover') {
        const downloaded = await result;
        expect(await readFile(downloaded.file, 'utf8')).toBe('abcdefgh');
        expect(progress).toEqual([4, 8]);
        expect(downloaded.sourceVersion).toBe('v1');
        expect(requested).toEqual(['bytes=0-3', 'bytes=0-3', 'bytes=4-7']);
        await downloaded.cleanup();
      } else {
        await expect(result).rejects.toThrow(
          mode === 'changed'
            ? 'SOURCE_CHANGED'
            : mode === 'cancelled'
              ? 'PROCESS_CANCELED'
              : 'DRIVE_UNAVAILABLE'
        );
        expect(requested).toHaveLength(mode === 'exhausted' ? 5 : mode === 'changed' ? 2 : 1);
        expect(progress).toEqual([]);
      }
      expect(await readdir(root)).toEqual([]);
    },
    20_000
  );

  it('resends the unacknowledged suffix after a partial upload and finalizes exactly once', async () => {
    const root = await temporaryRoot();
    const output = path.join(root, 'output.bin');
    await writeFile(output, new Uint8Array(512 * 1024));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            value: {
              operationId: 'operation-upload',
              sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              chunkMultiple: 256 * 1024
            }
          }),
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'drive-result-1' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            value: {
              operationId: 'operation-upload',
              state: 'succeeded',
              materialId: 'material-result-1',
              reused: false
            }
          }),
          { status: 200 }
        )
      );
    const client = new TeamTransferClient({ fetchImpl, temporaryRoot: root });
    const result = await client.uploadResult(
      {
        operationId: 'operation-upload',
        cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
        finalizeGrant: grant('finalize'),
        file: output,
        mimeType: 'video/mp4',
        sizeBytes: 512 * 1024
      },
      new AbortController().signal
    );

    expect(result).toMatchObject({ state: 'succeeded', materialId: 'material-result-1' });
    const uploadCalls = fetchImpl.mock.calls.slice(1, 3);
    expect(uploadCalls.map(([, init]) => new Headers(init?.headers).get('content-range'))).toEqual([
      'bytes 0-524287/524288',
      'bytes 262144-524287/524288'
    ]);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/process/output/finalize'))
    ).toHaveLength(1);
  });

  it.each([
    'transient',
    'rate-limited',
    'transport',
    'permanent',
    'exhausted',
    'cancelled'
  ] as const)(
    'retries only the identical finalize request: %s',
    async mode => {
      const root = await temporaryRoot();
      const output = path.join(root, 'finalize.bin');
      await writeFile(output, 'result');
      const controller = new AbortController();
      const finalBodies: unknown[] = [];
      let uploads = 0;
      let starts = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/start')) {
          starts += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              value: {
                sessionUri: 'https://www.googleapis.com/upload/result',
                chunkMultiple: 256 * 1024
              }
            })
          );
        }
        if (url.startsWith('https://www.googleapis.com/')) {
          uploads += 1;
          return new Response(JSON.stringify({ id: 'same-drive-file' }));
        }
        finalBodies.push(JSON.parse(String(init?.body)));
        if (mode === 'cancelled')
          setTimeout(() => controller.abort(new Error('PROCESS_CANCELED')), 10);
        if (mode === 'transport' && finalBodies.length === 1) throw new TypeError('fetch failed');
        if (
          mode === 'permanent' ||
          mode === 'exhausted' ||
          mode === 'cancelled' ||
          ((mode === 'transient' || mode === 'rate-limited') && finalBodies.length === 1)
        ) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: mode === 'rate-limited' ? 'RATE_LIMITED' : 'DRIVE_UNAVAILABLE',
                retryable: mode !== 'permanent'
              }
            }),
            { status: 503 }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              operationId: 'same-operation',
              state: 'succeeded',
              materialId: 'material',
              reused: true
            }
          })
        );
      });
      const client = new TeamTransferClient({ fetchImpl });
      const result = client.uploadResult(
        {
          operationId: 'same-operation',
          cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
          finalizeGrant: grant('finalize'),
          file: output,
          mimeType: 'video/mp4',
          sizeBytes: 6
        },
        controller.signal
      );
      if (mode === 'transient' || mode === 'rate-limited' || mode === 'transport')
        await expect(result).resolves.toMatchObject({ state: 'succeeded' });
      else
        await expect(result).rejects.toThrow(
          mode === 'cancelled' ? 'PROCESS_CANCELED' : 'DRIVE_UNAVAILABLE'
        );
      expect(starts).toBe(1);
      expect(uploads).toBe(1);
      expect(finalBodies).toHaveLength(
        mode === 'exhausted'
          ? 3
          : mode === 'transient' || mode === 'rate-limited' || mode === 'transport'
            ? 2
            : 1
      );
      for (const body of finalBodies)
        expect(body).toEqual({
          operationId: 'same-operation',
          ticket: grant('finalize').ticket,
          driveFileId: 'same-drive-file'
        });
    },
    15_000
  );

  it('sends a separate short-lived quiescence receipt after a canceled upload', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, value: { acknowledged: true } }), { status: 200 })
      );
    const client = new TeamTransferClient({ fetchImpl, temporaryRoot: await temporaryRoot() });
    await client.ackUploadQuiescence({
      operationId: 'operation-upload',
      cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
      finalizeGrant: grant('finalize')
    });
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/process\/output\/quiesced$/u);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      operationId: 'operation-upload'
    });
  });
});

describe('team processing orchestration and SSE state', () => {
  function processRequest() {
    return {
      operationId: 'operation-process',
      toolId: 'compressor',
      options: { mode: 'optimal' },
      sourceGrant: grant(),
      finalizeGrant: grant('finalize'),
      transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
      cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops'
    };
  }

  it('delegates to the existing tool, emits ordered progress, and returns one terminal result', async () => {
    const root = await temporaryRoot();
    const sourceFile = path.join(root, 'source.mp4');
    const outputFile = path.join(root, 'output.mp4');
    await writeFile(sourceFile, 'source');
    await writeFile(outputFile, 'result');
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file: sourceFile,
        sizeBytes: 6,
        sourceVersion: '1',
        sourceChecksum: 'check-1',
        cleanup
      }),
      uploadResult: vi.fn().mockResolvedValue({
        operationId: 'operation-process',
        state: 'succeeded',
        materialId: 'result-material',
        reused: false
      })
    };
    const delegate: TeamProcessDelegate = vi.fn().mockImplementation(async input => {
      input.onProgress(40);
      return { file: outputFile, mimeType: 'video/mp4', sizeBytes: 6 };
    });
    const emitted: unknown[] = [];
    const events = new TeamOperationEvents(event => emitted.push(event));
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events
    });

    await expect(bridge.process(processRequest())).resolves.toMatchObject({
      state: 'succeeded',
      materialId: 'result-material'
    });
    expect(delegate).toHaveBeenCalledOnce();
    expect(transfer.uploadResult).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events.snapshot().operations).toEqual([
      expect.objectContaining({
        operationId: 'operation-process',
        state: 'succeeded',
        progress: 100
      })
    ]);
    expect(JSON.stringify(emitted)).toMatch(/downloading.*processing.*uploading.*succeeded/s);
  });

  it('cancels the existing delegate, publishes canceled, and cleans temporary state', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    // Held in an object rather than a `let`: a variable assigned only inside a
    // callback keeps the narrowing from its initialiser, so `delegateSignal`
    // reads as `never` at the assertion below.
    const captured: { signal: AbortSignal | null } = { signal: null };
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: '/tmp/opaque-workspace',
        file: '/tmp/opaque-workspace/source',
        sizeBytes: 1,
        sourceVersion: null,
        sourceChecksum: null,
        cleanup
      }),
      uploadResult: vi.fn()
    };
    const delegate: TeamProcessDelegate = vi.fn().mockImplementation(
      input =>
        new Promise((_resolve, reject) => {
          captured.signal = input.signal;
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        })
    );
    const events = new TeamOperationEvents();
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    expect(await bridge.cancel('operation-process')).toBe(true);
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
    expect(captured.signal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events.snapshot().operations[0]).toMatchObject({ state: 'canceled' });
    expect(bridge.busy()).toBe(false);
  });

  it('refuses unknown/duplicate tool work without disrupting existing tool registrations', async () => {
    const transfer = {
      downloadSource: vi.fn(),
      uploadResult: vi.fn()
    } satisfies TeamProcessTransfer;
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: vi.fn() },
      events: new TeamOperationEvents()
    });
    await expect(bridge.process({ ...processRequest(), toolId: 'unknown' })).rejects.toThrow(
      'AGENT_UPDATE_REQUIRED'
    );
    expect(bridge.supportedTools()).toEqual(['compressor']);
  });

  /**
   * A run that hangs until the test stops it, offering the bridge a hold the
   * way the real compressor and transcription delegates do.
   */
  function heldRun(options: { offersPause?: boolean } = {}) {
    const asked: boolean[] = [];
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: '/tmp/opaque-workspace',
        file: '/tmp/opaque-workspace/source',
        sizeBytes: 1,
        sourceVersion: null,
        sourceChecksum: null,
        cleanup: vi.fn().mockResolvedValue(undefined)
      }),
      uploadResult: vi.fn()
    };
    const offer = (input: { pausable: (fn: ((paused: boolean) => boolean) | null) => void }) =>
      input.pausable(paused => {
        asked.push(paused);
        return true;
      });
    const delegate: TeamProcessDelegate = vi.fn().mockImplementation(
      input =>
        new Promise((_resolve, reject) => {
          if (options.offersPause !== false) offer(input);
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        })
    );
    return { transfer, delegate, asked, offer };
  }

  it('holds the running work and lets it go again', async () => {
    const { transfer, delegate, asked } = heldRun();
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());

    expect(bridge.setPaused('operation-process', true)).toBe('ok');
    expect(bridge.paused('operation-process')).toBe(true);
    expect(bridge.setPaused('operation-process', false)).toBe('ok');
    expect(bridge.paused('operation-process')).toBe(false);
    expect(asked).toEqual([true, false]);

    bridge.cancel('operation-process');
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
  });

  it('says nothing was held rather than claiming a pause it did not perform', async () => {
    // A transfer, a landing optimization, the moment between two children: the
    // interface has to be able to tell a quiet machine from a busy one.
    const { transfer, delegate } = heldRun({ offersPause: false });
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());

    expect(bridge.setPaused('operation-process', true)).toBe('unsupported');
    expect(bridge.paused('operation-process')).toBe(false);
    // Releasing something that was never held is the state the caller asked for.
    expect(bridge.setPaused('operation-process', false)).toBe('ok');

    bridge.cancel('operation-process');
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
  });

  it('re-applies a standing pause to the next hold a run offers', async () => {
    // A job that changes children mid-run — a held final image is three passes —
    // must not resume itself by starting the next one.
    const asked: boolean[] = [];
    const second: { offer: (() => void) | null } = { offer: null };
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: '/tmp/opaque-workspace',
        file: '/tmp/opaque-workspace/source',
        sizeBytes: 1,
        sourceVersion: null,
        sourceChecksum: null,
        cleanup: vi.fn().mockResolvedValue(undefined)
      }),
      uploadResult: vi.fn()
    };
    const delegate: TeamProcessDelegate = vi.fn().mockImplementation(
      input =>
        new Promise((_resolve, reject) => {
          const hold = (label: string) => (paused: boolean) => {
            asked.push(paused);
            void label;
            return true;
          };
          input.pausable(hold('first'));
          second.offer = () => input.pausable(hold('second'));
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        })
    );
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());

    expect(bridge.setPaused('operation-process', true)).toBe('ok');
    asked.length = 0;
    second.offer?.();
    expect(asked).toEqual([true]);

    bridge.cancel('operation-process');
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
  });

  it('lets a held run go before stopping it', async () => {
    // A suspended process is not delivered its termination signal until it runs
    // again: a cancel that did not resume first would wait for a resume nobody
    // is coming back to give.
    const { transfer, delegate, asked } = heldRun();
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    expect(bridge.setPaused('operation-process', true)).toBe('ok');

    expect(bridge.cancel('operation-process')).toBe(true);
    expect(asked).toEqual([true, false]);
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
  });

  it("does not spend the run's time budget while it is held", async () => {
    const { transfer, delegate } = heldRun();
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents(),
      watchdogMs: 300
    });
    const running = bridge.process(processRequest());
    const settled = running.catch((error: unknown) => error);
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    expect(bridge.setPaused('operation-process', true)).toBe('ok');

    // Well past the budget, and the run is still there because none of that
    // time was spent running.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(bridge.busy()).toBe(true);

    expect(bridge.setPaused('operation-process', false)).toBe('ok');
    await expect(settled).resolves.toMatchObject({ message: 'PROCESS_TIMEOUT' });
  });

  it('lets a hold go when the page stops saying it still wants it', async () => {
    // A reload leaves the request's socket open, so the agent cannot see the
    // page go; the pause is re-asserted instead, and lapses when that stops.
    vi.useFakeTimers();
    try {
      const { transfer, delegate, asked } = heldRun();
      const bridge = new TeamProcessBridge({
        transfer,
        delegates: { compressor: delegate },
        events: new TeamOperationEvents()
      });
      const running = bridge.process(processRequest());
      running.catch(() => undefined);
      await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());

      expect(bridge.setPaused('operation-process', true)).toBe('ok');
      // Still there, and asking again does not take a second hold.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.setPaused('operation-process', true)).toBe('ok');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(bridge.paused('operation-process')).toBe(true);
      expect(asked).toEqual([true]);

      // Nobody speaks for it again.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(bridge.paused('operation-process')).toBe(false);
      expect(asked).toEqual([true, false]);

      bridge.cancel('operation-process');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a held run go when the page that held it closes', async () => {
    // The run itself is not cancelled: the agent uploads the result on its own,
    // so a closed tab costs nobody their work — but a pause nothing can lift
    // would keep a stopped process on the machine until the app is quit.
    const { transfer, delegate, asked } = heldRun();
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });
    const running = bridge.process(processRequest());
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    expect(bridge.setPaused('operation-process', true)).toBe('ok');

    bridge.resume('operation-process');
    expect(asked).toEqual([true, false]);
    expect(bridge.paused('operation-process')).toBe(false);
    expect(bridge.busy()).toBe(true);

    bridge.cancel('operation-process');
    await expect(running).rejects.toThrow('PROCESS_CANCELED');
  });

  it('has nothing to hold once the work is over', async () => {
    const root = await temporaryRoot();
    const sourceFile = path.join(root, 'source.mp4');
    const outputFile = path.join(root, 'output.mp4');
    await writeFile(sourceFile, 'source');
    await writeFile(outputFile, 'result');
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file: sourceFile,
        sizeBytes: 6,
        sourceVersion: '1',
        sourceChecksum: 'check-1',
        cleanup: vi.fn().mockResolvedValue(undefined)
      }),
      uploadResult: vi.fn().mockResolvedValue({
        operationId: 'operation-process',
        state: 'succeeded',
        materialId: 'result-material',
        reused: false
      })
    };
    const delegate: TeamProcessDelegate = vi.fn().mockImplementation(async input => {
      input.pausable(() => true);
      return { file: outputFile, mimeType: 'video/mp4', sizeBytes: 6 };
    });
    const bridge = new TeamProcessBridge({
      transfer,
      delegates: { compressor: delegate },
      events: new TeamOperationEvents()
    });

    await expect(bridge.process(processRequest())).resolves.toMatchObject({ state: 'succeeded' });
    expect(bridge.setPaused('operation-process', true)).toBe('not-found');
  });
  it('preserves confirmed upload success when cancellation races the finalize reply', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'result.mp4');
    await writeFile(file, 'result');
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const events = new TeamOperationEvents();
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file,
        sizeBytes: 6,
        sourceVersion: null,
        sourceChecksum: null,
        cleanup
      }),
      uploadResult: vi.fn().mockImplementation(async () => {
        // The cloud already committed success, then the cancel request arrives
        // before this continuation consumes the confirmed finalize reply.
        expect(bridge.cancel('operation-process')).toBe(true);
        return {
          operationId: 'operation-process',
          state: 'succeeded',
          materialId: 'result-material',
          reused: false
        };
      })
    };
    const bridge = new TeamProcessBridge({
      transfer,
      events,
      delegates: { compressor: async () => ({ file, mimeType: 'video/mp4', sizeBytes: 6 }) }
    });
    await expect(bridge.process(processRequest())).resolves.toMatchObject({
      state: 'succeeded',
      materialId: 'result-material'
    });
    expect(events.snapshot().operations[0]).toMatchObject({ state: 'succeeded', errorCode: null });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(bridge.busy()).toBe(false);
  });

  it('acknowledges Launch restitch quiescence only after its upload promise settles', async () => {
    const root = await temporaryRoot();
    const file = path.join(root, 'restitch.mp4');
    await writeFile(file, 'result');
    const order: string[] = [];
    const transfer: TeamProcessTransfer = {
      downloadSource: vi.fn().mockResolvedValue({
        workspace: root,
        file,
        sizeBytes: 6,
        sourceVersion: null,
        sourceChecksum: null
      }),
      uploadResult: vi.fn().mockImplementation(async () => {
        order.push('upload');
        throw new Error('PROCESS_CANCELED');
      }),
      ackUploadQuiescence: vi.fn().mockImplementation(async () => {
        order.push('quiesced');
      })
    };
    const bridge = new TeamProcessBridge({
      transfer,
      events: new TeamOperationEvents(),
      delegates: { restitch: async () => ({ file, mimeType: 'video/mp4', sizeBytes: 6 }) }
    });
    await expect(bridge.process({ ...processRequest(), toolId: 'restitch' })).rejects.toThrow();
    expect(order).toEqual(['upload', 'quiesced']);
    expect(transfer.ackUploadQuiescence).toHaveBeenCalledOnce();
  });

  it.each([
    'RESTITCH_SCREEN_UNAVAILABLE',
    'RESTITCH_SCREEN_FETCH_FAILED',
    'RESTITCH_SCREEN_UNSUPPORTED'
  ])('preserves the actionable screen preparation failure %s', async code => {
    const events = new TeamOperationEvents();
    const bridge = new TeamProcessBridge({
      events,
      transfer: {
        downloadSource: async () => {
          throw new Error(code);
        },
        uploadResult: vi.fn()
      },
      delegates: { compressor: vi.fn() }
    });
    await expect(bridge.process(processRequest())).rejects.toThrow(code);
    expect(events.snapshot().operations[0]).toMatchObject({ state: 'failed', errorCode: code });
  });

  it.each(['provider token=secret https://example.invalid/ /private/path', 'PRIVATE_CAPI_SECRET'])(
    'logs only a closed failure code, excluding provider content (%s)',
    async message => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const events = new TeamOperationEvents();
      const bridge = new TeamProcessBridge({
        events,
        transfer: {
          downloadSource: async () => {
            throw new Error(message, {
              cause: new Error('secret-cause')
            });
          },
          uploadResult: vi.fn()
        },
        delegates: { compressor: vi.fn() }
      });
      try {
        await expect(bridge.process(processRequest())).rejects.toThrow('PROCESS_FAILED');
        expect(log).toHaveBeenCalledWith('[team-process] failed:', 'PROCESS_FAILED');
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|https:|private\/path/);
        expect(events.snapshot().operations[0]).toMatchObject({
          state: 'failed',
          errorCode: 'PROCESS_FAILED'
        });
      } finally {
        log.mockRestore();
      }
    }
  );
});
