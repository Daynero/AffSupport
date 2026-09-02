import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
    ).resolves.toEqual({ saved: true, fileName: '..-creative (1).mp4', sizeBytes: 10 });
    expect(await readFile(path.join(destination, '..-creative (1).mp4'), 'utf8')).toBe(
      'downloaded'
    );
    expect(await readFile(path.join(destination, '..-creative.mp4'), 'utf8')).toBe('existing');
    expect(cleanup).toHaveBeenCalledOnce();
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

  it('uploads output in aligned resumable chunks and finalizes exactly one result', async () => {
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
      'bytes 0-262143/524288',
      'bytes 262144-524287/524288'
    ]);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/process/output/finalize'))
    ).toHaveLength(1);
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

  it('does not spend the run\'s time budget while it is held', async () => {
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
});
