// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 057 T044 — the upload engine of an R2 space (T045, research R3, FR-039): at most eight parts at
 * once; a lost network waits and a reload resumes from the IndexedDB journal with only the
 * missing parts; the content id made from the part MD5s is the reference one and the one the
 * server recomputes from R2's own ETags; «already there» moves no byte; a dropped folder keeps
 * its tree; cancel closes the multipart. The engine's seams (API, hasher, fetch, journal) are
 * injected; the database and bucket rules are proven in space-storage-upload.test.ts.
 */

vi.mock('../apps/web/src/lib/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
  withFreshSession: <T>(run: () => PromiseLike<T>) => run(),
  requireSupabaseClient: () => {
    throw new Error('no transport in this test');
  }
}));

import { spaceContentId, spaceMd5Hex, SPACE_STORAGE_LIMITS } from '@video-compressor/shared';
import type { SpaceAdmitResult, SpaceMaterialSnapshot } from '@video-compressor/shared';
import { verifyListedParts } from '../supabase/functions/space-storage/uploads';
import {
  clearSpaceStorageCaches,
  rememberSpaceBackend,
  spaceStorageApi
} from '../apps/web/src/api/space-storage';
import { teamApi } from '../apps/web/src/api/team';
import { uploadTeamFile } from '../apps/web/src/team/catalog/material-actions-client';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { hashSpaceParts } from '../apps/web/src/team/storage/spaceHash';
import { uploadFileToSpace, type SpaceUploadDeps } from '../apps/web/src/team/storage/spaceUpload';
import {
  indexedDbSpaceUploadJournal,
  memorySpaceUploadJournal
} from '../apps/web/src/team/storage/spaceUploadJournal';

const id = (n: number) => `05744000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAM = id(1);
const ROOT = id(2);
const UPLOAD = id(3);
const MATERIAL = id(4);
const ACTOR = id(5);
const MIB = 1024 * 1024;
const PART = SPACE_STORAGE_LIMITS.defaultPartBytes;
const FUTURE = '2099-01-01T00:00:00.000Z';

const md5Of = (n: number) => n.toString(16).padStart(32, '0');

/** A source of `parts` parts that reads nothing real: the hasher and the bucket are fakes. */
function source(parts: number, lastModified = 1_700_000_000_000) {
  const size = (parts - 1) * PART + 1024;
  return {
    size,
    lastModified,
    readChunk: vi.fn(async (start: number, end: number) => new Blob([`${start}-${end}`]))
  };
}

function snapshot(contentId: string): SpaceMaterialSnapshot {
  return {
    id: MATERIAL,
    teamId: TEAM,
    parentMaterialId: ROOT,
    name: 'Clip.mp4',
    kind: 'file',
    lifecycle: 'active',
    materialRevision: '0',
    contentId,
    sizeBytes: '1',
    mimeType: 'video/mp4'
  };
}

function harness(parts: number, options: { admit?: SpaceAdmitResult } = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const failing = new Set<number>();
  const md5s = Array.from({ length: parts }, (_, index) => md5Of(index + 1));
  const api: SpaceUploadDeps['api'] = {
    admitUpload: vi.fn(async input => {
      calls.push(`admit ${input.idempotencyKey}`);
      return (
        options.admit ?? {
          kind: 'session' as const,
          uploadId: UPLOAD,
          partBytes: PART,
          partCount: parts,
          derivativeSlots: [],
          expiresAt: FUTURE
        }
      );
    }),
    partUrls: vi.fn(
      async (
        _team: string,
        _upload: string,
        list: readonly { partNumber: number; md5: string }[]
      ) =>
        list.map(part => ({
          partNumber: part.partNumber,
          url: `https://acct.r2.cloudflarestorage.com/soty-spaces-beta/x?partNumber=${part.partNumber}`,
          expiresAt: FUTURE
        }))
    ),
    completeUpload: vi.fn(
      async (
        _team: string,
        _upload: string,
        list: readonly { partNumber: number; etag: string }[]
      ) => {
        calls.push(`complete ${list.length}`);
        const id = await spaceContentId(
          source(parts).size,
          list.map(part => part.etag)
        );
        return snapshot(id.ok ? id.contentId : 'x');
      }
    ),
    abortUpload: vi.fn(async () => {
      calls.push('abort');
      return { aborted: true as const };
    }),
    declareDerivatives: vi.fn(async () => [])
  };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const part = Number(new URL(String(url)).searchParams.get('partNumber'));
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight -= 1;
    if (failing.has(part)) throw new TypeError('Failed to fetch');
    calls.push(`put ${part}`);
    return new Response(null, { status: 200, headers: { ETag: `"${md5s[part - 1]}"` } });
  }) as unknown as typeof globalThis.fetch;
  const hash = vi.fn(async () => [...md5s]);
  const deps: Partial<SpaceUploadDeps> = {
    api,
    fetch,
    hash,
    journal: memorySpaceUploadJournal(),
    derivatives: null,
    online: async () => undefined,
    sleep: async () => undefined,
    actor: () => ACTOR
  };
  return { api, fetch, hash, deps, calls, failing, md5s, peak: () => peak };
}

const input = (src: ReturnType<typeof source>, signal?: AbortSignal) => ({
  teamId: TEAM,
  parentMaterialId: ROOT,
  name: 'Clip.mp4',
  contentType: 'video/mp4',
  source: src,
  idempotencyKey: 'upload-key-0000000000000001',
  ...(signal ? { signal } : {})
});

beforeEach(() => {
  clearSpaceStorageCaches();
  setPrivateCacheScope(ACTOR, 'test');
});
afterEach(() => vi.restoreAllMocks());

describe('parts', () => {
  it('sends at most eight parts at a time, each once, then completes with every ETag', async () => {
    const run = harness(20);
    const result = await uploadFileToSpace(input(source(20)), run.deps);
    expect(result.reused).toBe(false);
    expect(run.peak()).toBeLessThanOrEqual(8);
    expect(run.peak()).toBeGreaterThan(1);
    expect(run.calls.filter(call => call.startsWith('put')).sort()).toHaveLength(20);
    expect(run.calls.at(-1)).toBe('complete 20');
  });

  it('a part sent with Content-MD5 whose ETag is not that MD5 is not trusted', async () => {
    const run = harness(1);
    (run.deps.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { ETag: `"${'f'.repeat(32)}"` } })
    );
    await expect(uploadFileToSpace(input(source(1)), run.deps)).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH'
    });
    expect(run.calls).not.toContain('complete 1');
  });
});

describe('resume', () => {
  it('after the network went away, a reload sends only the missing parts, without hashing again', async () => {
    const run = harness(6);
    run.failing.add(4);
    run.failing.add(6);
    const file = source(6);
    await expect(uploadFileToSpace(input(file), run.deps)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      retryable: true
    });
    // The session stays open for the next attempt: nothing was aborted.
    expect(run.calls).not.toContain('abort');
    expect(run.hash).toHaveBeenCalledTimes(1);

    // The page reloads: same journal, the same file chosen again under a new key.
    run.failing.clear();
    run.calls.length = 0;
    const result = await uploadFileToSpace(
      { ...input(file), idempotencyKey: 'upload-key-0000000000000002' },
      run.deps
    );
    expect(result.materialId).toBe(MATERIAL);
    expect(run.hash).toHaveBeenCalledTimes(1);
    // The journal's key, not the new one: the server answers the same session.
    expect(run.calls[0]).toBe('admit upload-key-0000000000000001');
    expect(run.calls.filter(call => call.startsWith('put')).sort()).toEqual(['put 4', 'put 6']);
    expect(run.calls.at(-1)).toBe('complete 6');
  });

  it('forgets the journal once the upload is in', async () => {
    const journal = memorySpaceUploadJournal();
    const run = harness(3);
    run.failing.add(3);
    const file = source(3);
    await expect(uploadFileToSpace(input(file), { ...run.deps, journal })).rejects.toBeTruthy();
    run.failing.clear();
    run.calls.length = 0;
    await uploadFileToSpace(input(file), { ...run.deps, journal });
    expect(run.calls.filter(call => call.startsWith('put'))).toEqual(['put 3']);
    // Done: the same file again is a fresh upload (the server says whether it is already there).
    await uploadFileToSpace(input(file), { ...run.deps, journal });
    expect(run.hash).toHaveBeenCalledTimes(2);
  });

  it('without IndexedDB (private mode, blocked storage) the upload still goes, unjournaled', async () => {
    expect(typeof indexedDB).toBe('undefined');
    const journal = indexedDbSpaceUploadJournal('soty-space-uploads-test');
    const run = harness(2);
    await expect(
      uploadFileToSpace(input(source(2)), { ...run.deps, journal })
    ).resolves.toMatchObject({
      materialId: MATERIAL
    });
    await expect(journal.get('anything')).resolves.toBeNull();
  });

  it('waits for the network to come back before trying a part again', async () => {
    const run = harness(1);
    let back!: () => void;
    const online = vi.fn(() => new Promise<void>(resolve => (back = resolve)));
    (run.deps.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('Failed to fetch')
    );
    const pending = uploadFileToSpace(input(source(1)), { ...run.deps, online });
    await vi.waitFor(() => expect(online).toHaveBeenCalled());
    expect(run.calls).not.toContain('complete 1');
    back();
    await expect(pending).resolves.toMatchObject({ materialId: MATERIAL });
  });

  it('another account never resumes this one', async () => {
    const run = harness(2);
    run.failing.add(2);
    const file = source(2);
    await expect(uploadFileToSpace(input(file), run.deps)).rejects.toBeTruthy();
    run.failing.clear();
    run.calls.length = 0;
    await uploadFileToSpace(
      { ...input(file), idempotencyKey: 'upload-key-0000000000000009' },
      { ...run.deps, actor: () => id(99) }
    );
    expect(run.calls[0]).toBe('admit upload-key-0000000000000009');
    expect(run.hash).toHaveBeenCalledTimes(2);
  });
});

describe('content identity', () => {
  it('the part MD5s match the reference and the id the server recomputes from R2 ETags', async () => {
    const bytes = new Uint8Array(PART + 3 * MIB).map((_, index) => index % 251);
    const md5s = await hashSpaceParts(new Blob([bytes]));
    expect(md5s).toEqual([spaceMd5Hex(bytes.subarray(0, PART)), spaceMd5Hex(bytes.subarray(PART))]);
    const client = await spaceContentId(bytes.length, md5s);
    if (!client.ok) throw new Error('fixture');
    const server = await verifyListedParts(
      { partCount: 2, declaredBytes: BigInt(bytes.length), declaredContentId: client.contentId },
      [
        { partNumber: 1, etag: md5s[0]!, bytes: PART },
        { partNumber: 2, etag: md5s[1]!, bytes: 3 * MIB }
      ]
    );
    expect(server.ok).toBe(true);
  });
});

describe('already there', () => {
  it('moves no byte when the space already holds the content', async () => {
    const run = harness(4, { admit: { kind: 'exists', materialId: MATERIAL } });
    const result = await uploadFileToSpace(input(source(4)), run.deps);
    expect(result).toEqual({ materialId: MATERIAL, reused: true, material: null });
    expect(run.fetch).not.toHaveBeenCalled();
    expect(run.api.partUrls).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('closes the multipart and keeps nothing to resume', async () => {
    const run = harness(10);
    const controller = new AbortController();
    (run.deps.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort(new Error('CANCELED'));
      throw new DOMException('aborted', 'AbortError');
    });
    const file = source(10);
    await expect(uploadFileToSpace(input(file, controller.signal), run.deps)).rejects.toThrow(
      'CANCELED'
    );
    expect(run.calls).toContain('abort');
    // Nothing kept: the next attempt hashes again.
    (run.deps.fetch as ReturnType<typeof vi.fn>).mockReset();
    run.calls.length = 0;
    await uploadFileToSpace(input(file), { ...run.deps, fetch: harness(10).fetch }).catch(
      () => undefined
    );
    expect(run.hash).toHaveBeenCalledTimes(2);
  });
});

describe('a dropped folder', () => {
  it('keeps its tree: each folder under its parent, each file in its folder', async () => {
    rememberSpaceBackend(TEAM, 'r2');
    const folders = new Map<string, string>([
      ['A', id(20)],
      ['B', id(21)]
    ]);
    const mutate = vi.spyOn(spaceStorageApi, 'mutate').mockImplementation(async input => {
      if (input.action !== 'create_folder') throw new Error('unexpected');
      return {
        materials: [
          {
            id: folders.get(input.name)!,
            teamId: TEAM,
            parentMaterialId: input.parentMaterialId,
            name: input.name,
            kind: 'folder',
            lifecycle: 'active',
            materialRevision: '0',
            contentId: null,
            sizeBytes: null,
            mimeType: null
          }
        ],
        contentRevision: '1',
        created: true
      };
    });
    const admit = vi
      .spyOn(spaceStorageApi, 'admitUpload')
      .mockResolvedValue({ kind: 'exists', materialId: MATERIAL });
    const a = await teamApi.ensureUploadFolder(TEAM, { name: 'A', parentMaterialId: null });
    const b = await teamApi.ensureUploadFolder(TEAM, { name: 'B', parentMaterialId: a.materialId });
    await uploadTeamFile({
      teamId: TEAM,
      destinationFolderId: b.folderId,
      file: new File(['clip'], 'Clip.mp4', { type: 'video/mp4' }),
      conflictMode: 'keep_both',
      replaceMaterialId: null,
      versionOfMaterialId: null
    });
    expect(
      mutate.mock.calls.map(([call]) => [
        call.action,
        'name' in call ? call.name : null,
        'parentMaterialId' in call ? call.parentMaterialId : null
      ])
    ).toEqual([
      ['create_folder', 'A', null],
      ['create_folder', 'B', id(20)]
    ]);
    expect(admit.mock.calls[0]![0]).toMatchObject({ parentMaterialId: id(21), name: 'Clip.mp4' });
  });
});
