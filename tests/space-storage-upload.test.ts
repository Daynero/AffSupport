import { describe, expect, it, vi } from 'vitest';
import { spaceContentId } from '../packages/shared/src/team/space-storage';
import { spaceMd5Hex } from '../packages/shared/src/team/space-storage-md5';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { SpaceListedPart } from '../supabase/functions/_shared/r2-space';
import type { SpaceStorageJournalEntry } from '../supabase/functions/_shared/space-storage-journal';
import {
  abortUpload,
  admitUpload,
  completeUpload,
  multipartObjectEtag,
  parseAdmitCommand,
  parsePartsCommand,
  signUploadParts,
  verifyListedParts,
  type SpaceUploadBucket,
  type UploadDeps
} from '../supabase/functions/space-storage/uploads';

/**
 * 057 T021 — the upload routes of `space-storage` (T023) against a fake database and a fake
 * bucket. The database rules themselves (reservation, dedup, atomic commit) are proven in
 * supabase/tests/database/space-storage-commit.test.sql; here: what the function asks, what it
 * trusts (R2's part ETags, never the client's) and in which order it refuses.
 */

const ACTOR = '05721000-0000-4000-8000-000000000001';
const TEAM = '05721000-0000-4000-8000-000000000011';
const ROOT = '05721000-0000-4000-8000-000000000101';
const OTHER = '05721000-0000-4000-8000-000000000102';
const UPLOAD = '05721000-0000-4000-8000-0000000000a1';
const MATERIAL = '05721000-0000-4000-8000-0000000000b1';
const BYTES = new TextEncoder().encode('ten bytes!');
const PART_MD5 = spaceMd5Hex(BYTES);

async function contentOf(etags: string[], bytes = BYTES.length) {
  const result = await spaceContentId(bytes, etags);
  if (!result.ok) throw new Error('fixture');
  return result.contentId;
}

interface Session {
  state: 'open' | 'completing' | 'committed' | 'expired' | 'aborted' | 'rejected';
  r2UploadId: string | null;
  declaredContentId: string;
  expired: boolean;
}

/** The database as the function sees it: closed answers of each service RPC. */
function fakeDatabase(contentId: string) {
  const state = {
    allowed: true,
    session: null as Session | null,
    exists: null as null | 'same' | 'linked',
    quota: false,
    commits: 0
  };
  const sessionJson = (s: Session) => ({
    kind: 'session',
    uploadId: UPLOAD,
    partBytes: 16 * 1024 * 1024,
    partCount: 1,
    derivativeSlots: [],
    expiresAt: '2026-11-29T00:00:00.000Z',
    state: s.state,
    r2UploadId: s.r2UploadId,
    objectKey: `t/${TEAM}/o/${s.declaredContentId}`,
    declaredContentId: s.declaredContentId,
    declaredBytes: String(BYTES.length),
    objectEtag: null,
    resultMaterialId: null,
    name: 'Clip.mp4',
    contentType: 'video/mp4',
    teamId: TEAM
  });
  const snapshot = {
    id: MATERIAL,
    teamId: TEAM,
    parentMaterialId: ROOT,
    name: 'Clip.mp4',
    kind: 'file',
    lifecycle: 'active',
    materialRevision: '0',
    contentId,
    sizeBytes: String(BYTES.length),
    mimeType: 'video/mp4'
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'service_space_storage_context':
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: true,
          actorPilot: true,
          workspaceAllowed: true,
          archived: false,
          allowed: state.allowed,
          accessEpoch: '0',
          contentRevision: '0',
          rootMaterialId: ROOT
        };
      case 'service_admit_space_upload': {
        const input = args.p_input as Record<string, unknown>;
        if (state.quota) return { kind: 'quota', needBytes: input.bytes, freeBytes: '3' };
        if (state.exists === 'same') return { kind: 'exists', materialId: MATERIAL };
        if (state.exists === 'linked')
          return { kind: 'exists', materialId: '05721000-0000-4000-8000-0000000000b2' };
        state.session ??= {
          state: 'open',
          r2UploadId: null,
          declaredContentId: String(input.contentId),
          expired: false
        };
        return sessionJson(state.session);
      }
      case 'service_attach_space_upload':
        state.session!.r2UploadId ??= String(args.p_r2_upload_id);
        return sessionJson(state.session!);
      case 'service_space_upload_session': {
        const s = state.session!;
        if (s.expired && s.state === 'open') s.state = 'expired';
        if (s.state === 'expired' || s.state === 'aborted')
          return { kind: 'expired', state: s.state };
        if (s.state === 'rejected')
          return { kind: 'rejected', state: s.state, code: 'CHECKSUM_MISMATCH' };
        return sessionJson(s);
      }
      case 'service_mark_space_upload_completing':
        if (args.p_content_id !== state.session!.declaredContentId)
          throw { message: 'CHECKSUM_MISMATCH' };
        state.session!.state = 'completing';
        return sessionJson(state.session!);
      case 'service_complete_space_upload':
        if (state.session!.state !== 'committed') state.commits += 1;
        state.session!.state = 'committed';
        return snapshot;
      case 'service_reject_space_upload':
        state.session!.state = 'rejected';
        return null;
      case 'service_abort_space_upload':
        state.session!.state = 'aborted';
        return { aborted: true };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  return { rpc, state };
}

function fakeBucket(listed: () => SpaceListedPart[] | 'gone') {
  const calls: string[] = [];
  const objects = new Map<string, number>();
  const bucket: SpaceUploadBucket = {
    createMultipart: vi.fn(async key => {
      calls.push(`create ${key}`);
      return 'r2-upload-1';
    }),
    signPart: vi.fn(async (_key, uploadId, partNumber, md5) => {
      calls.push(`sign ${partNumber}`);
      return {
        partNumber,
        url: `https://acct.r2.cloudflarestorage.com/soty-spaces-beta/x?partNumber=${partNumber}&uploadId=${uploadId}`,
        contentMd5: md5,
        expiresAt: '2026-11-28T00:10:00.000Z'
      };
    }),
    listParts: vi.fn(async () => {
      calls.push('list');
      const parts = listed();
      if (parts === 'gone') throw new TeamFunctionError('NOT_FOUND', { retryable: false });
      return parts;
    }),
    completeMultipart: vi.fn(async key => {
      calls.push('complete');
      objects.set(key, BYTES.length);
      return { etag: '"x-1"' };
    }),
    abortMultipart: vi.fn(async () => {
      calls.push('abort');
    }),
    head: vi.fn(async key => {
      calls.push('head');
      const bytes = objects.get(key);
      return bytes === undefined ? null : { bytes, etag: '"x-1"', contentType: 'video/mp4' };
    })
  };
  return { bucket, calls, objects };
}

const journal: SpaceStorageJournalEntry[] = [];
function deps(rpc: UploadDeps['rpc'], bucket: SpaceUploadBucket): UploadDeps {
  return {
    actorId: ACTOR,
    rpc,
    bucket,
    journal: async entry => {
      journal.push(entry);
      return true;
    },
    operationId: '05721000-0000-4000-8000-0000000000ff',
    client: { kind: 'web', version: '1.8.0+110' }
  };
}

const admitBody = (contentId: string, parent = ROOT) => ({
  teamId: TEAM,
  parentMaterialId: parent,
  name: ' Clip.mp4 ',
  contentType: 'video/mp4; codecs=avc1',
  bytes: String(BYTES.length),
  contentId,
  sha256: null,
  derivatives: [],
  ingress: 'explorer',
  idempotencyKey: 'f0b3c6a2-2b9e-4a52-9d55-6d0e8f1c2a77'
});

describe('admit', () => {
  it('opens a session and the multipart at the content key, once', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket, calls } = fakeBucket(() => []);
    const result = await admitUpload(parseAdmitCommand(admitBody(contentId)), deps(db.rpc, bucket));
    expect(result).toEqual({
      kind: 'session',
      uploadId: UPLOAD,
      partBytes: 16 * 1024 * 1024,
      partCount: 1,
      derivativeSlots: [],
      expiresAt: '2026-11-29T00:00:00.000Z'
    });
    expect(calls).toEqual([`create t/${TEAM}/o/${contentId}`]);
    const input = db.rpc.mock.calls.find(([name]) => name === 'service_admit_space_upload')![1]
      .p_input as Record<string, unknown>;
    expect(input).toMatchObject({
      name: 'Clip.mp4',
      contentType: 'video/mp4',
      bytes: '10',
      category: 'video',
      fileExtension: 'mp4'
    });
    await admitUpload(parseAdmitCommand(admitBody(contentId)), deps(db.rpc, bucket));
    expect(calls).toHaveLength(1);
  });

  it('answers exists for the same content in the same folder, and moves no bytes', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    db.state.exists = 'same';
    const { bucket, calls } = fakeBucket(() => []);
    expect(
      await admitUpload(parseAdmitCommand(admitBody(contentId)), deps(db.rpc, bucket))
    ).toEqual({ kind: 'exists', materialId: MATERIAL });
    expect(calls).toEqual([]);
  });

  it('links a new material in another folder to the bytes already there', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    db.state.exists = 'linked';
    const { bucket, calls } = fakeBucket(() => []);
    const result = await admitUpload(
      parseAdmitCommand(admitBody(contentId, OTHER)),
      deps(db.rpc, bucket)
    );
    expect(result).toEqual({ kind: 'exists', materialId: '05721000-0000-4000-8000-0000000000b2' });
    expect(calls).toEqual([]);
  });

  it('names how much the upload needs and how much is free', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    db.state.quota = true;
    const { bucket } = fakeBucket(() => []);
    const error = await admitUpload(
      parseAdmitCommand(admitBody(contentId)),
      deps(db.rpc, bucket)
    ).catch(cause => cause as TeamFunctionError);
    expect(error).toBeInstanceOf(TeamFunctionError);
    expect((error as TeamFunctionError).code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect((error as TeamFunctionError).status).toBe(409);
    expect((error as TeamFunctionError).details).toEqual({ needBytes: '10', freeBytes: '3' });
  });

  it('refuses malformed declarations before the database', () => {
    expect(() => parseAdmitCommand({ ...admitBody('a'.repeat(64)), contentId: 'x' })).toThrow(
      'INVALID_INPUT'
    );
    expect(() => parseAdmitCommand({ ...admitBody('a'.repeat(64)), bytes: 10 })).toThrow(
      'INVALID_INPUT'
    );
    expect(() => parseAdmitCommand({ ...admitBody('a'.repeat(64)), name: 'a/b' })).toThrow(
      'INVALID_INPUT'
    );
    expect(() =>
      parseAdmitCommand({ ...admitBody('a'.repeat(64)), bytes: String(100 * 1024 ** 3 + 1) })
    ).toThrow('STORAGE_OBJECT_TOO_LARGE');
    expect(() =>
      parseAdmitCommand({
        ...admitBody('a'.repeat(64)),
        derivatives: [
          { variant: 'row', contentType: 'image/png', bytes: '10', width: 1, height: 1 }
        ]
      })
    ).toThrow('INVALID_INPUT');
  });
});

describe('parts', () => {
  it('signs only the session parts, checking the right again on every call', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket, calls } = fakeBucket(() => []);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    const signed = await signUploadParts(
      UPLOAD,
      parsePartsCommand({ teamId: TEAM, parts: [{ partNumber: 1, md5: PART_MD5 }] }),
      d
    );
    expect(signed.parts).toHaveLength(1);
    expect(Object.keys(signed.parts[0]!).sort()).toEqual(['expiresAt', 'partNumber', 'url']);
    await expect(
      signUploadParts(
        UPLOAD,
        parsePartsCommand({ teamId: TEAM, parts: [{ partNumber: 2, md5: PART_MD5 }] }),
        d
      )
    ).rejects.toThrow('INVALID_INPUT');
    db.state.allowed = false;
    await expect(
      signUploadParts(
        UPLOAD,
        parsePartsCommand({ teamId: TEAM, parts: [{ partNumber: 1, md5: PART_MD5 }] }),
        d
      )
    ).rejects.toThrow('PERMISSION_DENIED');
    expect(calls.filter(call => call.startsWith('sign'))).toEqual(['sign 1']);
    const contexts = db.rpc.mock.calls.filter(([name]) => name === 'service_space_storage_context');
    expect(contexts.every(([, args]) => args.p_permission === 'upload')).toBe(true);
  });

  it('an expired session is UPLOAD_EXPIRED', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket } = fakeBucket(() => []);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    db.state.session!.expired = true;
    await expect(
      signUploadParts(
        UPLOAD,
        parsePartsCommand({ teamId: TEAM, parts: [{ partNumber: 1, md5: PART_MD5 }] }),
        d
      )
    ).rejects.toThrow('UPLOAD_EXPIRED');
    await expect(completeUpload(UPLOAD, { teamId: TEAM }, d)).rejects.toThrow('UPLOAD_EXPIRED');
  });
});

describe('complete', () => {
  it('recomputes the content id from what R2 lists, completes, commits — and a repeat returns the same', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket, calls } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: 10 }]);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    const first = await completeUpload(UPLOAD, { teamId: TEAM }, d);
    expect(first).toMatchObject({ id: MATERIAL, contentId, sizeBytes: '10' });
    const marked = db.rpc.mock.calls.find(
      ([name]) => name === 'service_mark_space_upload_completing'
    )![1];
    expect(marked.p_object_etag).toBe(multipartObjectEtag([PART_MD5]));
    expect(String(marked.p_object_etag)).toMatch(/^[0-9a-f]{32}-1$/u);
    const second = await completeUpload(UPLOAD, { teamId: TEAM }, d);
    expect(second.id).toBe(first.id);
    expect(db.state.commits).toBe(1);
    expect(calls.filter(call => call === 'complete')).toHaveLength(1);
  });

  it('after a reply lost behind the completion, finds the object and commits it', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    let gone = false;
    const { bucket, objects, calls } = fakeBucket(() =>
      gone ? 'gone' : [{ partNumber: 1, etag: PART_MD5, bytes: 10 }]
    );
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    // The first attempt completed in R2 but died before the commit.
    db.state.session!.state = 'completing';
    objects.set(`t/${TEAM}/o/${contentId}`, 10);
    gone = true;
    const result = await completeUpload(UPLOAD, { teamId: TEAM }, d);
    expect(result.id).toBe(MATERIAL);
    expect(calls).toContain('head');
    expect(calls).not.toContain('complete');
  });

  it('parts that do not make the declared content are refused, aborted and never committed', async () => {
    const declared = await contentOf([PART_MD5]);
    const db = fakeDatabase(declared);
    // R2 holds other bytes than the client declared.
    const { bucket, calls } = fakeBucket(() => [
      { partNumber: 1, etag: spaceMd5Hex(new TextEncoder().encode('other bytes')), bytes: 10 }
    ]);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(declared)), d);
    await expect(completeUpload(UPLOAD, { teamId: TEAM }, d)).rejects.toThrow('CHECKSUM_MISMATCH');
    expect(calls).toContain('abort');
    expect(calls).not.toContain('complete');
    expect(db.state.commits).toBe(0);
    expect(db.state.session!.state).toBe('rejected');
  });

  it('missing or extra parts are a mismatch too', async () => {
    const declared = await contentOf([PART_MD5]);
    const db = fakeDatabase(declared);
    const { bucket } = fakeBucket(() => []);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(declared)), d);
    await expect(completeUpload(UPLOAD, { teamId: TEAM }, d)).rejects.toThrow('CHECKSUM_MISMATCH');
  });

  it('a person whose upload right went away between admit and complete is refused', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket, calls } = fakeBucket(() => [{ partNumber: 1, etag: PART_MD5, bytes: 10 }]);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    db.state.allowed = false;
    await expect(completeUpload(UPLOAD, { teamId: TEAM }, d)).rejects.toThrow('PERMISSION_DENIED');
    expect(calls).not.toContain('list');
    expect(calls).not.toContain('complete');
    expect(db.state.commits).toBe(0);
  });
});

describe('the canonical split', () => {
  // R2 refuses unequal non-last parts at completion (400 InvalidPart, qualification
  // 2026-11-28); the content id is canonical only for the split the length implies.
  const MIB = 1024 * 1024;
  const total = 16 * MIB + 10;
  const a = spaceMd5Hex(new TextEncoder().encode('a'));
  const b = spaceMd5Hex(new TextEncoder().encode('b'));
  const facts = async () => ({
    partCount: 2,
    declaredBytes: BigInt(total),
    declaredContentId: await contentOf([a, b], total)
  });

  it('accepts parts of the size the declared length implies', async () => {
    const listed: SpaceListedPart[] = [
      { partNumber: 1, etag: a, bytes: 16 * MIB },
      { partNumber: 2, etag: b, bytes: 10 }
    ];
    const verdict = await verifyListedParts(await facts(), listed);
    expect(verdict).toMatchObject({ ok: true, objectEtag: multipartObjectEtag([a, b]) });
  });

  it('refuses another split of the same length, even when its ETags make the declared id', async () => {
    const listed: SpaceListedPart[] = [
      { partNumber: 1, etag: a, bytes: 16 * MIB - 5 },
      { partNumber: 2, etag: b, bytes: 15 }
    ];
    expect(await verifyListedParts(await facts(), listed)).toEqual({ ok: false });
  });
});

describe('abort and the journal', () => {
  it('closes the multipart and frees the reservation', async () => {
    const contentId = await contentOf([PART_MD5]);
    const db = fakeDatabase(contentId);
    const { bucket, calls } = fakeBucket(() => []);
    const d = deps(db.rpc, bucket);
    await admitUpload(parseAdmitCommand(admitBody(contentId)), d);
    expect(await abortUpload(UPLOAD, { teamId: TEAM }, d)).toEqual({ aborted: true });
    expect(calls).toContain('abort');
    expect(db.state.session!.state).toBe('aborted');
  });

  it('writes stages without names, keys or URLs', () => {
    const text = JSON.stringify(journal, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    expect(text).not.toContain('Clip');
    expect(text).not.toContain('t/');
    expect(text).not.toContain('https://');
    expect(new Set(journal.map(entry => entry.stage))).toEqual(
      new Set(['admit', 'parts', 'complete', 'abort'])
    );
  });
});
