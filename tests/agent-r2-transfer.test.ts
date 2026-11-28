import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spaceContentId, type TeamTransferGrant } from '@video-compressor/shared';
import { SpaceR2Transfer } from '../apps/agent/src/team-bridge/r2-transfer';
import { TeamSourceCache } from '../apps/agent/src/team-bridge/source-cache';
import {
  TeamSourceIntegrityError,
  TeamTransferClient
} from '../apps/agent/src/team-bridge/transfer';

/**
 * 057 T032 — the agent's transfer for an R2 space (T033): multipart output with `Content-MD5`
 * parts and at most four in flight, a journal that resumes a broken upload, Range reads from the
 * files host with a fresh grant on 401, a hash mismatch that commits nothing, the power governor
 * narrowing the parallelism, and the source cache keyed by content id (F11).
 */

const MIB = 1024 * 1024;
const BASE = 'https://project.supabase.co/functions/v1/space-storage';
const SOURCE_URL = `${BASE}/agent/source`;
const FILES = 'https://files-beta.soty.pp.ua';
const TEAM = '05732000-0000-4000-8000-000000000011';
const OPERATION = '05732000-0000-4000-8000-0000000000c1';
const UPLOAD = '05732000-0000-4000-8000-0000000000d1';
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');

function grant(purpose: TeamTransferGrant['purpose']): TeamTransferGrant {
  return {
    ticket: `${purpose}-ticket`.padEnd(43, 'x'),
    purpose,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxRangeBytes: 32 * MIB,
    maxUses: 240
  };
}

function bytesOf(length: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 4096) buffer[index] = (index / 4096 + seed) % 251;
  return buffer;
}

async function contentIdOf(buffer: Buffer): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < buffer.length; start += 16 * MIB)
    parts.push(md5(buffer.subarray(start, Math.min(start + 16 * MIB, buffer.length))));
  const result = await spaceContentId(buffer.length, parts);
  if (!result.ok) throw new Error('fixture');
  return result.contentId;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { ok: true, value } : { error: value }), {
    status,
    headers: { 'content-type': 'application/json' }
  });

let root: string;
let output: Buffer;
let outputFile: string;
let source: Buffer;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agent-r2-transfer-'));
  // Five parts: four of 16 MiB and a short last one.
  output = bytesOf(64 * MIB + 1024, 1);
  outputFile = path.join(root, 'output.mp4');
  await writeFile(outputFile, output);
  // Three parts, read in two 32 MiB ranges and a short one.
  source = bytesOf(33 * MIB, 2);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The space-storage function, the files host and R2, as the agent meets them. */
function fakeCloud(
  options: {
    partFailures?: (partNumber: number, attempt: number) => 'network' | 'ok';
    wrongEtag?: boolean;
    firstReadExpired?: boolean;
    servedSource?: Buffer;
    declaredSource?: Buffer;
    putDelayMs?: number;
  } = {}
) {
  const state = {
    sourceTrades: 0,
    rangeReads: 0,
    puts: new Map<number, number>(),
    inFlight: 0,
    maxInFlight: 0,
    starts: [] as Record<string, unknown>[],
    signs: [] as number[][],
    finalizes: [] as Record<string, unknown>[],
    md5Headers: new Map<number, string>()
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body;
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(body)) as Record<string, unknown>;
      expect((init.headers as Record<string, string>)['x-soty-capabilities']).toBe('storage-r2/1');
      if (url.pathname.endsWith('/agent/source')) {
        state.sourceTrades += 1;
        return json({
          url: `${FILES}/t/${TEAM}/o/${await contentIdOf(options.declaredSource ?? source)}?g=grant-${state.sourceTrades}`,
          bytes: (options.declaredSource ?? source).length,
          contentId: await contentIdOf(options.declaredSource ?? source),
          expiresAt: new Date(Date.now() + 600_000).toISOString()
        });
      }
      if (url.pathname.endsWith('/process/output/start')) {
        state.starts.push(payload);
        return json({
          kind: 'session',
          uploadId: UPLOAD,
          partBytes: 16 * MIB,
          partCount: Math.ceil(Number(payload.bytes) / (16 * MIB)),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        });
      }
      if (url.pathname.endsWith('/process/output/parts')) {
        const parts = payload.parts as { partNumber: number; md5: string }[];
        state.signs.push(parts.map(part => part.partNumber));
        return json({
          parts: parts.map(part => ({
            partNumber: part.partNumber,
            url: `https://acct.r2.cloudflarestorage.com/soty-spaces-beta/t/${TEAM}/o/x?partNumber=${part.partNumber}&X-Amz-Signature=s`,
            expiresAt: new Date(Date.now() + 600_000).toISOString()
          }))
        });
      }
      if (url.pathname.endsWith('/process/output/finalize')) {
        state.finalizes.push(payload);
        return json({
          operationId: OPERATION,
          state: 'succeeded',
          materialId: '05732000-0000-4000-8000-0000000000e1',
          reused: state.finalizes.length > 1
        });
      }
      throw new Error(`unexpected POST ${url.pathname}`);
    }
    if (init?.method === 'PUT') {
      const partNumber = Number(url.searchParams.get('partNumber'));
      const attempt = (state.puts.get(partNumber) ?? 0) + 1;
      state.puts.set(partNumber, attempt);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, options.putDelayMs ?? 5));
        if (options.partFailures?.(partNumber, attempt) === 'network')
          throw new TypeError('fetch failed');
        const bytes = body as Buffer;
        const header = (init.headers as Record<string, string>)['content-md5'];
        state.md5Headers.set(partNumber, header);
        const digest = createHash('md5').update(bytes).digest();
        // R2 refuses a part whose bytes are not the signed MD5.
        if (header !== digest.toString('base64')) return new Response('BadDigest', { status: 400 });
        const etag = options.wrongEtag ? 'f'.repeat(32) : digest.toString('hex');
        return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
      } finally {
        state.inFlight -= 1;
      }
    }
    if (url.origin === FILES) {
      state.rangeReads += 1;
      if (options.firstReadExpired && state.rangeReads === 1)
        return new Response(null, { status: 401 });
      const served = options.servedSource ?? source;
      const match = /^bytes=(\d+)-(\d+)$/u.exec((init?.headers as Record<string, string>).range)!;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), served.length - 1);
      return new Response(new Uint8Array(served.subarray(start, end + 1)), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${served.length}`,
          'content-length': String(end - start + 1)
        }
      });
    }
    throw new Error(`unexpected ${init?.method} ${url}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, state };
}

const uploadRequest = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  cloudBaseUrl: BASE,
  finalizeGrant: grant('finalize'),
  file: outputFile,
  mimeType: 'video/mp4',
  sizeBytes: output.length,
  ...overrides
});

describe('agent R2 output upload (057 T033)', () => {
  it('sends Content-MD5 parts, at most four at once, and finalizes once', async () => {
    const cloud = fakeCloud({ putDelayMs: 20 });
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: root,
      journalRoot: path.join(root, 'journal-a'),
      threadBudget: () => null,
      retryDelayMs: 0
    });
    const result = await transfer.uploadResult(uploadRequest(), new AbortController().signal);
    expect(result).toMatchObject({ operationId: OPERATION, state: 'succeeded', reused: false });
    expect(cloud.state.starts[0]).toMatchObject({
      outputUploadProtocolVersion: 3,
      bytes: output.length,
      contentId: await contentIdOf(output),
      contentType: 'video/mp4'
    });
    expect([...cloud.state.puts.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    for (const [partNumber, header] of cloud.state.md5Headers) {
      const start = (partNumber - 1) * 16 * MIB;
      const part = output.subarray(start, Math.min(start + 16 * MIB, output.length));
      expect(header).toBe(createHash('md5').update(part).digest('base64'));
    }
    expect(cloud.state.maxInFlight).toBe(4);
    expect(cloud.state.finalizes).toHaveLength(1);
    expect(cloud.state.finalizes[0]).toMatchObject({ operationId: OPERATION, uploadId: UPLOAD });
  });

  it('runs one part at a time when the power governor allows one thread', async () => {
    const cloud = fakeCloud();
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: root,
      journalRoot: path.join(root, 'journal-b'),
      threadBudget: () => 1,
      retryDelayMs: 0
    });
    await transfer.uploadResult(uploadRequest(), new AbortController().signal);
    expect(cloud.state.maxInFlight).toBe(1);
  });

  it('resumes a broken upload from its journal without resending acknowledged parts', async () => {
    const journalRoot = path.join(root, 'journal-c');
    const broken = fakeCloud({ partFailures: part => (part === 3 ? 'network' : 'ok') });
    const first = new SpaceR2Transfer({
      fetchImpl: broken.fetchImpl,
      temporaryRoot: root,
      journalRoot,
      threadBudget: () => 1,
      retryDelayMs: 0
    });
    await expect(first.uploadResult(uploadRequest(), new AbortController().signal)).rejects.toThrow(
      'STORAGE_UNAVAILABLE'
    );
    expect(broken.state.puts.get(3)).toBe(4);
    expect(broken.state.finalizes).toHaveLength(0);

    const healed = fakeCloud();
    const second = new SpaceR2Transfer({
      fetchImpl: healed.fetchImpl,
      temporaryRoot: root,
      journalRoot,
      threadBudget: () => 1,
      retryDelayMs: 0
    });
    await second.uploadResult(uploadRequest(), new AbortController().signal);
    expect([...healed.state.puts.keys()].sort()).toEqual([3, 4, 5]);
    expect(healed.state.signs.flat()).toEqual([3, 4, 5]);
    expect(healed.state.finalizes).toHaveLength(1);
    // A finished upload leaves no journal behind.
    expect(await readdir(journalRoot)).toEqual([]);
  });

  it('stops without finalizing when R2 reports a part that is not its MD5', async () => {
    const cloud = fakeCloud({ wrongEtag: true });
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: root,
      journalRoot: path.join(root, 'journal-d'),
      threadBudget: () => 1,
      retryDelayMs: 0
    });
    await expect(
      transfer.uploadResult(uploadRequest(), new AbortController().signal)
    ).rejects.toThrow('CHECKSUM_MISMATCH');
    expect(cloud.state.finalizes).toHaveLength(0);
  });
});

describe('agent R2 source download (057 T033)', () => {
  it('reads Range pieces from the files host and trades the ticket again on 401', async () => {
    const cloud = fakeCloud({ firstReadExpired: true });
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: root,
      retryDelayMs: 0
    });
    const downloaded = await transfer.downloadSource(
      { operationId: OPERATION, transferUrl: SOURCE_URL, grant: grant('process_input') },
      new AbortController().signal
    );
    try {
      expect(cloud.state.sourceTrades).toBe(2);
      expect(cloud.state.rangeReads).toBe(1 + 2);
      expect(downloaded.sizeBytes).toBe(source.length);
      expect(downloaded.sourceVersion).toBe(await contentIdOf(source));
      expect(downloaded.sourceChecksum).toBe(md5(source));
      expect((await readFile(downloaded.file)).equals(source)).toBe(true);
    } finally {
      await downloaded.cleanup();
    }
  });

  it('refuses bytes whose content id is not the named one, and keeps nothing', async () => {
    const tampered = Buffer.from(source);
    tampered[5] = (tampered[5]! + 1) % 256;
    const cloud = fakeCloud({ servedSource: tampered });
    const keepContent = vi.fn(async () => undefined);
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: path.join(root, 'tampered'),
      sourceCache: { placeContent: async () => false, keepContent },
      retryDelayMs: 0
    });
    const failure = await transfer
      .downloadSource(
        { operationId: OPERATION, transferUrl: SOURCE_URL, grant: grant('process_input') },
        new AbortController().signal
      )
      .catch(error => error);
    expect(failure).toBeInstanceOf(TeamSourceIntegrityError);
    expect((failure as TeamSourceIntegrityError).reason).toBe('checksum_mismatch');
    expect(keepContent).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, 'tampered'))).toEqual([]);
  });

  it('reads the same content a second time from the source cache, not the network', async () => {
    const cache = new TeamSourceCache({ root: path.join(root, 'cache') });
    const cloud = fakeCloud();
    const transfer = new SpaceR2Transfer({
      fetchImpl: cloud.fetchImpl,
      temporaryRoot: root,
      sourceCache: cache,
      retryDelayMs: 0
    });
    const first = await transfer.downloadSource(
      { operationId: OPERATION, transferUrl: SOURCE_URL, grant: grant('process_input') },
      new AbortController().signal
    );
    await first.cleanup();
    const reads = cloud.state.rangeReads;
    const second = await transfer.downloadSource(
      { operationId: OPERATION, transferUrl: SOURCE_URL, grant: grant('process_input') },
      new AbortController().signal
    );
    try {
      expect(cloud.state.rangeReads).toBe(reads);
      // The server is still asked: the ticket keeps its authorization in the loop.
      expect(cloud.state.sourceTrades).toBe(2);
      expect((await stat(second.file)).size).toBe(source.length);
      expect(second.sourceChecksum).toBe(md5(source));
    } finally {
      await second.cleanup();
    }
  });
});

describe('TeamTransferClient picks the storage by address (057 T033)', () => {
  it('sends an R2 space through space-storage and never through drive-transfer', async () => {
    const cloud = fakeCloud();
    const client = new TeamTransferClient({ fetchImpl: cloud.fetchImpl, temporaryRoot: root });
    const downloaded = await client.downloadSource(
      { operationId: OPERATION, transferUrl: SOURCE_URL, grant: grant('download_range') },
      new AbortController().signal
    );
    await downloaded.cleanup();
    const paths = (cloud.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      call => new URL(String(call[0])).pathname
    );
    expect(paths.some(entry => entry.includes('drive-transfer'))).toBe(false);
    expect(paths[0]).toBe('/functions/v1/space-storage/agent/source');
  });
});
