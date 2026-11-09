import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  TeamDownloadBridge,
  type TeamAgentDownloadRequest
} from '../apps/agent/src/team-bridge/download';
import { removeTemporaryDirectory } from './support/temp-dir';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'download-quiescence-'));
});
afterEach(async () => {
  await removeTemporaryDirectory(root);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(beforeSave?: () => Promise<void>) {
  const file = path.join(root, 'source.bin'),
    destination = path.join(root, 'destination');
  await writeFile(file, 'synthetic');
  await mkdir(destination);
  const started = deferred<void>(),
    done = deferred<void>();
  const cleanup = vi.fn(async () => {
    started.resolve();
    await done.promise;
  });
  const transfer = {
    downloadSource: vi.fn(async () => ({
      workspace: root,
      file,
      sizeBytes: 9,
      sourceVersion: '1',
      sourceChecksum: null,
      cleanup
    }))
  };
  const bridge = new TeamDownloadBridge({ transfer, reveal: () => {}, beforeSave });
  const request: TeamAgentDownloadRequest = {
    operationId: 'cleanup-owned-download',
    transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
    transferGrant: {
      ticket: 'opaque-download-ticket-with-enough-entropy',
      purpose: 'download_range',
      expiresAt: '2026-11-07T12:00:00Z',
      maxRangeBytes: 10,
      maxUses: 1
    },
    fileName: 'synthetic.bin',
    destination,
    reveal: false
  };
  return { started, done, cleanup, transfer, bridge, request };
}
it('keeps the original download busy and excludes a same-ID restart until source cleanup settles', async () => {
  const f = await fixture(),
    first = f.bridge.download(f.request);
  await f.started.promise;
  const busyDuringCleanup = f.bridge.busy();
  const second = f.bridge.download(f.request).then(
    () => null,
    error => error as Error
  );
  f.done.resolve();
  await first;
  const refusal = await second;
  expect(busyDuringCleanup).toBe(true);
  expect(refusal?.message).toBe('WRONG_STATE');
  expect(f.transfer.downloadSource).toHaveBeenCalledTimes(1);
  expect(f.bridge.busy()).toBe(false);
});
it('shutdown waits for the original cleanup instead of treating an abort request as completion', async () => {
  const f = await fixture(),
    run = f.bridge.download(f.request);
  await f.started.promise;
  let finished = false;
  const shutdown = f.bridge.shutdown().then(() => {
    finished = true;
  });
  await Promise.resolve();
  const finishedBeforeCleanup = finished;
  f.done.resolve();
  await Promise.all([run, shutdown]);
  expect(finishedBeforeCleanup).toBe(false);
  expect(f.bridge.busy()).toBe(false);
});
it('joins an outstanding destination choice and closes admission before awaiting it', async () => {
  const choice = deferred<string | null>(),
    started = deferred<void>();
  let observedSignal: AbortSignal | undefined;
  const transfer = { downloadSource: vi.fn() };
  const bridge = new TeamDownloadBridge({
    transfer,
    chooseDestination: async signal => {
      observedSignal = signal;
      started.resolve();
      return choice.promise;
    }
  });
  const f = await fixture(),
    request = { ...f.request, destination: null };
  const run = bridge.download(request).catch(error => error as Error);
  await started.promise;
  let finished = false;
  const shutdown = bridge.shutdown().then(() => {
    finished = true;
  });
  await Promise.resolve();
  const early = finished;
  const newRun = bridge
    .download({ ...request, operationId: 'new-after-shutdown' })
    .catch(error => error as Error);
  choice.resolve(null);
  const [error, refused] = await Promise.all([run, newRun, shutdown]);
  expect(observedSignal?.aborted).toBe(true);
  expect(early).toBe(false);
  expect(error).toMatchObject({ message: 'DOWNLOAD_CANCELED' });
  expect(refused).toMatchObject({ message: 'WRONG_STATE' });
  expect(transfer.downloadSource).not.toHaveBeenCalled();
});

it('joins the final authority check and stops a canceled file before copying it', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const outcome = f.bridge.download(f.request).catch((error: Error) => error);
  await entered.promise;
  expect(f.bridge.cancel(f.request.operationId)).toBe(true);
  expect(f.bridge.busy()).toBe(true);
  release.resolve();
  await f.started.promise;
  expect(await readdir(f.request.destination!)).toEqual([]);
  expect(f.bridge.busy()).toBe(true);
  f.done.resolve();
  expect(await outcome).toMatchObject({ message: 'DOWNLOAD_CANCELED' });
  expect(f.bridge.busy()).toBe(false);
});

it.each(['downloading', 'processing', 'finalizing'] as const)(
  'reports the actual %s failure phase without depending on progress listeners',
  async stage => {
    const f = await fixture(),
      original = Error('SYNTHETIC_FAILURE');
    f.done.resolve();
    if (stage === 'downloading') f.transfer.downloadSource.mockRejectedValue(original);
    const report = vi.fn();
    const bridge = new TeamDownloadBridge({
      transfer: f.transfer,
      reveal: () => {},
      onFailureStage: report,
      delegates: {
        restitch: async () => {
          throw original;
        }
      },
      beforeSave: async () => {
        if (stage === 'finalizing') throw original;
      }
    });
    await expect(
      bridge.download({
        ...f.request,
        process: stage === 'processing' ? { tool: 'restitch', defaults: {} } : null
      })
    ).rejects.toBe(original);
    expect(report).toHaveBeenCalledExactlyOnceWith(stage);
    expect(bridge.busy()).toBe(false);
  }
);
it('keeps the original failure when a diagnostic listener throws', async () => {
  const f = await fixture(),
    original = Error('SYNTHETIC_FAILURE');
  f.transfer.downloadSource.mockRejectedValue(original);
  const bridge = new TeamDownloadBridge({
    transfer: f.transfer,
    onFailureStage: () => {
      throw Error('DIAGNOSTIC_FAILURE');
    }
  });
  await expect(bridge.download(f.request)).rejects.toBe(original);
});
