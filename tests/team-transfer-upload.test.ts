import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamTransferClient } from '../apps/agent/src/team-bridge/transfer.js';
import { removeTemporaryDirectory } from './support/temp-dir.js';

const roots: string[] = [];
const MIB = 1024 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => removeTemporaryDirectory(root)));
});

async function fixture(size: number, cancelAfterChunk = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-upload-test-'));
  roots.push(root);
  const file = path.join(root, 'output.mp4');
  const source = Buffer.alloc(size);
  for (let i = 0; i < size; i++) source[i] = i % 251;
  await writeFile(file, source);
  const controller = new AbortController();
  const lengths: number[] = [];
  let received = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/process/output/start')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        outputUploadProtocolVersion: 2,
        checksum: createHash('md5').update(source).digest('hex')
      });
      return Response.json({
        ok: true,
        value: {
          sessionUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque',
          chunkMultiple: 256 * 1024
        }
      });
    }
    if (String(url).endsWith('/process/output/finalize')) {
      expect(received).toBe(size);
      return Response.json({
        ok: true,
        value: {
          operationId: 'upload-performance',
          state: 'succeeded',
          materialId: 'result',
          reused: false
        }
      });
    }
    const bytes = init?.body as Buffer;
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('PUT');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBe(controller.signal);
    expect(headers.get('content-length')).toBe(String(bytes.length));
    expect(headers.get('content-range')).toBe(
      `bytes ${received}-${received + bytes.length - 1}/${size}`
    );
    expect(bytes.equals(source.subarray(received, received + bytes.length))).toBe(true);
    lengths.push(bytes.length);
    received += bytes.length;
    if (received === size) return Response.json({ id: 'drive-result' }, { status: 201 });
    expect(bytes.length % (256 * 1024)).toBe(0);
    return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
  });
  const progress = vi.fn(() => {
    if (cancelAfterChunk) controller.abort(new Error('PROCESS_CANCELED'));
  });
  const client = new TeamTransferClient({ fetchImpl, temporaryRoot: root });
  const run = () =>
    client.uploadResult(
      {
        operationId: 'upload-performance',
        cloudBaseUrl: 'https://project.supabase.co/functions/v1/drive-ops',
        finalizeGrant: {
          ticket: 'opaque-finalize-ticket-with-enough-entropy',
          purpose: 'finalize',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          maxRangeBytes: 32 * MIB,
          maxUses: 1
        },
        file,
        mimeType: 'video/mp4',
        sizeBytes: size,
        onProgress: progress
      },
      controller.signal
    );
  return { run, lengths, progress, fetchImpl, controller, file };
}

it.each([
  { size: 512 * 1024, lengths: [512 * 1024] },
  { size: 32 * MIB, lengths: [8 * MIB, 8 * MIB, 8 * MIB, 8 * MIB] },
  { size: 8 * MIB + 123, lengths: [8 * MIB, 123] }
])('uploads $size bytes with bounded requests and exact content', async ({ size, lengths }) => {
  const f = await fixture(size);
  await expect(f.run()).resolves.toMatchObject({ state: 'succeeded' });
  expect(f.lengths).toEqual(lengths);
  expect(f.progress.mock.calls).toEqual(
    lengths.map((_, index) => [lengths.slice(0, index + 1).reduce((a, b) => a + b, 0), size])
  );
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/finalize'))).toHaveLength(
    1
  );
});

it('cancels between large chunks without sending more bytes or finalizing', async () => {
  const f = await fixture(16 * MIB, true);
  await expect(f.run()).rejects.toThrow('PROCESS_CANCELED');
  expect(f.lengths).toEqual([8 * MIB]);
  expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/finalize'))).toHaveLength(
    0
  );
});

it('does not start a provider upload when canceled before checksum production', async () => {
  const f = await fixture(MIB);
  f.controller.abort(new Error('PROCESS_CANCELED'));
  await expect(f.run()).rejects.toThrow('PROCESS_CANCELED');
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

it('refuses a file changed after hashing before sending its first provider chunk', async () => {
  const f = await fixture(MIB);
  const original = f.fetchImpl.getMockImplementation()!;
  f.fetchImpl.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (String(url).endsWith('/process/output/start')) {
      await writeFile(f.file, Buffer.alloc(MIB + 1));
    }
    return response;
  });
  await expect(f.run()).rejects.toThrow('SOURCE_CHANGED');
  expect(f.lengths).toEqual([]);
});

it.each(['different-provider-file', '../unsafe', 42])(
  'refuses an unexpected provider identity: %j',
  async providerFileId => {
    const f = await fixture(1024);
    const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).endsWith('/process/output/start')) return response;
      const payload = await response.json();
      payload.value.providerFileId = providerFileId;
      return Response.json(payload);
    });
    await expect(f.run()).rejects.toThrow(
      providerFileId === 'different-provider-file' ? 'SOURCE_CHANGED' : 'INVALID_RESPONSE'
    );
    expect(
      f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/finalize'))
    ).toHaveLength(0);
    if (providerFileId !== 'different-provider-file') expect(f.lengths).toEqual([]);
  }
);
