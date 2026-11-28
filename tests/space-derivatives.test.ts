// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * 057 T046 — derivatives of an R2 space (T047, research R5, FR-038 refinement): the browser makes
 * the three explorer sizes, and for a video the poster, the hover frames, the duration and the
 * size, one file at a time; a file already in the space makes nothing; the server checks each
 * staged picture by its first bytes, size and header dimensions and commits only those; what
 * the browser cannot read is left to an agent, with the original downloadable meanwhile.
 * Decoders are injected: jsdom has no real image or video decoding.
 */

vi.mock('../apps/web/src/lib/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
  requireSupabaseClient: () => {
    throw new Error('no transport in this test');
  }
}));

import {
  checkSpaceDerivative,
  SPACE_DERIVATIVE_SPRITE,
  SPACE_STORAGE_LIMITS,
  sniffSpaceDerivative,
  spaceMd5Hex
} from '@video-compressor/shared';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import {
  claimDerivativeJob,
  finishAgentDerivative,
  leaseHash,
  settleStagedDerivatives,
  stageAgentDerivatives,
  type SpaceDerivativeBucket
} from '../supabase/functions/space-storage/derivatives';
import {
  admitUpload,
  completeUpload,
  declareDerivatives,
  parseAdmitCommand,
  type UploadDeps
} from '../supabase/functions/space-storage/uploads';
import {
  deriveSpacePictures,
  fitWithin,
  spriteTimes,
  type SpaceCanvasEncoder,
  type SpaceFrame,
  type SpacePictureDecoder
} from '../apps/web/src/team/storage/spaceDerivatives';
import { uploadFileToSpace, type SpaceUploadDeps } from '../apps/web/src/team/storage/spaceUpload';
import { memorySpaceUploadJournal } from '../apps/web/src/team/storage/spaceUploadJournal';

const id = (n: number) => `05746100-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAM = id(1);
const ACTOR = id(2);
const UPLOAD = id(3);
const OBJECT = id(4);
const CLAIM = id(5);
const MATERIAL = id(6);
const CONTENT = 'c'.repeat(64);

/** A WebP (VP8X) header of the given size, padded to `bytes`. */
function webp(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 30));
  out.set(new TextEncoder().encode('RIFF'), 0);
  out.set(new TextEncoder().encode('WEBPVP8X'), 8);
  out[16] = 10;
  const w = width - 1;
  const h = height - 1;
  out.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  out.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return out;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0
  ]);
}

describe('the first bytes say what a picture is', () => {
  it('reads WebP (VP8X, VP8L, VP8) and JPEG sizes, and nothing else', () => {
    expect(sniffSpaceDerivative(webp(480, 270))).toEqual({
      contentType: 'image/webp',
      width: 480,
      height: 270
    });
    const lossless = webp(1, 1);
    lossless.set(new TextEncoder().encode('VP8L'), 12);
    const bits = (160 - 1) | ((90 - 1) << 14);
    lossless[20] = 0x2f;
    lossless.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 21);
    expect(sniffSpaceDerivative(lossless)).toMatchObject({ width: 160, height: 90 });
    const lossy = webp(1, 1);
    lossy.set(new TextEncoder().encode('VP8 '), 12);
    lossy.set([0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00], 23);
    expect(sniffSpaceDerivative(lossy)).toMatchObject({ width: 320, height: 240 });
    expect(sniffSpaceDerivative(jpeg(1600, 900))).toEqual({
      contentType: 'image/jpeg',
      width: 1600,
      height: 900
    });
    expect(sniffSpaceDerivative(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffSpaceDerivative(new Uint8Array(0))).toBeNull();
  });

  it('refuses a foreign type, a size over the variant or not as declared, and other dimensions', () => {
    const declared = {
      variant: 'tile',
      contentType: 'image/webp',
      bytes: 64,
      width: 480,
      height: 270
    } as const;
    expect(checkSpaceDerivative(declared, { bytes: 64, head: webp(480, 270) })).toEqual({
      ok: true
    });
    expect(checkSpaceDerivative(declared, { bytes: 64, head: jpeg(480, 270) })).toEqual({
      ok: false,
      reason: 'type'
    });
    expect(checkSpaceDerivative(declared, { bytes: 65, head: webp(480, 270) })).toEqual({
      ok: false,
      reason: 'size'
    });
    expect(
      checkSpaceDerivative(
        { ...declared, bytes: 300 * 1024 },
        { bytes: 300 * 1024, head: webp(480, 270) }
      )
    ).toEqual({ ok: false, reason: 'size' });
    expect(checkSpaceDerivative(declared, { bytes: 64, head: webp(481, 270) })).toEqual({
      ok: false,
      reason: 'dimensions'
    });
  });
});

// The browser -----------------------------------------------------------------------------------

function frame(width: number, height: number): SpaceFrame {
  return { width, height, source: {} as CanvasImageSource, close: vi.fn() };
}

function encoder(type: 'image/webp' | 'image/jpeg' = 'image/webp'): SpaceCanvasEncoder & {
  calls: Array<{ width: number; height: number; cells: number }>;
} {
  const calls: Array<{ width: number; height: number; cells: number }> = [];
  return {
    calls,
    async encode(input) {
      calls.push({ width: input.width, height: input.height, cells: input.cells.length });
      return new Blob([`${input.width}x${input.height}@${input.quality}`], {
        type: input.type === type ? type : 'image/png'
      });
    }
  };
}

describe('the browser makes the pictures of its own file', () => {
  it('an image: row, tile and full, each fitted and never enlarged', async () => {
    const decoder: SpacePictureDecoder = {
      image: async () => frame(4000, 3000),
      video: async () => null
    };
    const made = await deriveSpacePictures(new Blob(['x']), {
      contentType: 'image/jpeg',
      slots: ['row', 'tile', 'full'],
      decoder,
      encoder: encoder()
    });
    expect(made.unsupported).toBe(false);
    expect(made.media).toEqual({ durationMs: null, width: 4000, height: 3000 });
    expect(
      made.derivatives.map(item => [item.variant, item.width, item.height, item.contentType])
    ).toEqual([
      ['row', 160, 120, 'image/webp'],
      ['tile', 480, 360, 'image/webp'],
      ['full', 1600, 1200, 'image/webp']
    ]);
    for (const item of made.derivatives) {
      expect(item.md5).toBe(spaceMd5Hex(new Uint8Array(await item.blob.arrayBuffer())));
      expect(item.bytes).toBe(item.blob.size);
    }
    expect(fitWithin(100, 50, 480)).toEqual({ width: 100, height: 50 });
  });

  it('a browser that cannot write WebP gives JPEG instead', async () => {
    const decoder: SpacePictureDecoder = {
      image: async () => frame(800, 600),
      video: async () => null
    };
    const made = await deriveSpacePictures(new Blob(['x']), {
      contentType: 'image/png',
      slots: ['tile'],
      decoder,
      encoder: encoder('image/jpeg')
    });
    expect(made.derivatives.map(item => item.contentType)).toEqual(['image/jpeg']);
  });

  it('a video: the stills from its poster frame, the poster, ten hover frames in one image, its duration and size', async () => {
    const seen: number[] = [];
    const decoder: SpacePictureDecoder = {
      image: async () => null,
      video: async () => ({
        durationMs: 20_000,
        width: 1080,
        height: 1920,
        frameAt: async seconds => {
          seen.push(seconds);
          return frame(1080, 1920);
        },
        close: vi.fn()
      })
    };
    const canvas = encoder();
    const made = await deriveSpacePictures(new Blob(['x']), {
      contentType: 'video/mp4',
      slots: ['row', 'tile', 'full', 'poster', 'sprite'],
      decoder,
      encoder: canvas
    });
    expect(made.media).toEqual({ durationMs: 20_000, width: 1080, height: 1920 });
    expect(made.derivatives.map(item => item.variant)).toEqual([
      'row',
      'tile',
      'full',
      'poster',
      'sprite'
    ]);
    expect(seen[0]).toBe(1);
    expect(seen.slice(1)).toEqual(spriteTimes(20_000));
    const sprite = made.derivatives.find(item => item.variant === 'sprite')!;
    const cell = fitWithin(1080, 1920, SPACE_DERIVATIVE_SPRITE.frameMaxEdge);
    expect([sprite.width, sprite.height]).toEqual([cell.width * 5, cell.height * 2]);
    expect(canvas.calls.at(-1)?.cells).toBe(SPACE_DERIVATIVE_SPRITE.frames);
  });

  it('what the browser cannot decode is said so, for an agent', async () => {
    const decoder: SpacePictureDecoder = { image: async () => null, video: async () => null };
    for (const [contentType, slots] of [
      ['video/quicktime', ['tile', 'poster']],
      ['image/heic', ['tile']]
    ] as const) {
      const made = await deriveSpacePictures(new Blob(['x']), {
        contentType,
        slots: [...slots],
        decoder,
        encoder: encoder()
      });
      expect(made).toEqual({ derivatives: [], media: null, unsupported: true });
    }
  });
});

describe('the upload stages them in the same commit', () => {
  function engine(slots: Array<'row' | 'tile' | 'full' | 'poster' | 'sprite'>, exists = false) {
    const calls: string[] = [];
    const api: SpaceUploadDeps['api'] = {
      admitUpload: vi.fn(async () =>
        exists
          ? { kind: 'exists' as const, materialId: MATERIAL }
          : {
              kind: 'session' as const,
              uploadId: UPLOAD,
              partBytes: SPACE_STORAGE_LIMITS.defaultPartBytes,
              partCount: 1,
              derivativeSlots: slots,
              expiresAt: '2099-01-01T00:00:00.000Z'
            }
      ),
      partUrls: vi.fn(async () => [
        {
          partNumber: 1,
          url: 'https://acct.r2.cloudflarestorage.com/b/o?partNumber=1',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      ]),
      completeUpload: vi.fn(async () => {
        calls.push('complete');
        return {
          id: MATERIAL,
          teamId: TEAM,
          parentMaterialId: null,
          name: 'a.jpg',
          kind: 'file' as const,
          lifecycle: 'active' as const,
          materialRevision: '0',
          contentId: CONTENT,
          sizeBytes: '1',
          mimeType: 'image/jpeg'
        };
      }),
      abortUpload: vi.fn(async () => ({ aborted: true as const })),
      declareDerivatives: vi.fn(
        async (
          _team: string,
          _upload: string,
          input: Parameters<SpaceUploadDeps['api']['declareDerivatives']>[2]
        ) => {
          calls.push(`declare ${input.derivatives.map(item => item.variant).join(',')}`);
          return input.derivatives.map(item => ({
            variant: item.variant,
            url: `https://acct.r2.cloudflarestorage.com/b/stage-${item.variant}`,
            contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==',
            contentType: item.contentType,
            expiresAt: '2099-01-01T00:00:00.000Z'
          }));
        }
      )
    };
    const derivatives = vi.fn<NonNullable<SpaceUploadDeps['derivatives']>>(async () => ({
      derivatives: [
        {
          variant: 'tile',
          contentType: 'image/webp',
          bytes: 3,
          width: 480,
          height: 360,
          md5: 'a'.repeat(32),
          blob: new Blob(['abc'])
        }
      ],
      media: { durationMs: null, width: 4000, height: 3000 },
      unsupported: false
    }));
    const fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(
        String(url).includes('stage-') ? `put ${String(url).split('stage-')[1]}` : 'put part'
      );
      return new Response(null, {
        status: 200,
        headers: { ETag: `"${spaceMd5Hex(new TextEncoder().encode('abc'))}"` }
      });
    }) as unknown as typeof globalThis.fetch;
    const deps: Partial<SpaceUploadDeps> = {
      api,
      fetch,
      derivatives,
      journal: memorySpaceUploadJournal(),
      hash: async () => [spaceMd5Hex(new TextEncoder().encode('abc'))],
      online: async () => undefined,
      sleep: async () => undefined,
      actor: () => ACTOR
    };
    return { api, deps, calls, derivatives };
  }
  const file = () => new File(['abc'], 'a.jpg', { type: 'image/jpeg', lastModified: 1 });
  const upload = (deps: Partial<SpaceUploadDeps>) =>
    uploadFileToSpace(
      {
        teamId: TEAM,
        parentMaterialId: null,
        name: 'a.jpg',
        contentType: 'image/jpeg',
        source: file(),
        idempotencyKey: 'k'.repeat(20)
      },
      deps
    );

  it('declares and puts the pictures before the complete', async () => {
    const run = engine(['row', 'tile', 'full']);
    await upload(run.deps);
    expect(run.derivatives).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ slots: ['row', 'tile', 'full'] })
    );
    expect(run.calls.indexOf('declare tile')).toBeGreaterThanOrEqual(0);
    expect(run.calls.indexOf('put tile')).toBeLessThan(run.calls.indexOf('complete'));
    expect(run.api.declareDerivatives).toHaveBeenCalledWith(
      TEAM,
      UPLOAD,
      expect.objectContaining({
        media: { durationMs: null, width: 4000, height: 3000 },
        unsupported: false
      }),
      undefined
    );
  });

  it('content the space already holds makes no picture and sends none', async () => {
    const run = engine([], true);
    await upload(run.deps);
    expect(run.derivatives).not.toHaveBeenCalled();
    expect(run.api.declareDerivatives).not.toHaveBeenCalled();
  });

  it('a session that asks for nothing (pictures already there, a document) makes none', async () => {
    const run = engine([]);
    await upload(run.deps);
    expect(run.derivatives).not.toHaveBeenCalled();
  });

  it('a picture that fails never fails the upload', async () => {
    const run = engine(['tile']);
    run.derivatives.mockRejectedValueOnce(new Error('DECODE_FAILED'));
    await expect(upload(run.deps)).resolves.toMatchObject({ materialId: MATERIAL });
    expect(run.calls).toContain('complete');
  });
});

// The server ------------------------------------------------------------------------------------

function bucket(objects: Map<string, Uint8Array>) {
  const calls: string[] = [];
  const fake: SpaceDerivativeBucket = {
    signPut: vi.fn(async key => ({
      url: `https://acct.r2.cloudflarestorage.com/soty-spaces-beta/${key}?X-Amz-Signature=x`,
      contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==',
      expiresAt: '2026-11-28T00:10:00.000Z'
    })),
    head: vi.fn(async key => {
      const bytes = objects.get(key);
      return bytes ? { bytes: bytes.length, etag: '"x"', contentType: 'image/webp' } : null;
    }),
    rangeGet: vi.fn(async (key, start, end) => objects.get(key)!.subarray(start, end + 1)),
    copy: vi.fn(async (source, target) => {
      calls.push(`copy ${source.split('/').at(-1)} -> ${target.split('/').slice(-2).join('/')}`);
      objects.set(target, objects.get(source)!);
    }),
    remove: vi.fn(async key => {
      calls.push(`remove ${key.split('/').at(-1)}`);
      objects.delete(key);
    })
  };
  return { fake, calls };
}

const staging = (variant: string, owner = UPLOAD) => `t/${TEAM}/u/${owner}/${variant}`;
const final = (variant: string) => `t/${TEAM}/d/${CONTENT}/1/${variant}`;

describe('the server checks what was staged', () => {
  it('copies what fits to its content key, refuses the rest, and clears the staging', async () => {
    const objects = new Map<string, Uint8Array>([
      [staging('tile'), webp(480, 270)],
      [staging('row'), jpeg(160, 90)],
      [staging('full'), webp(1600, 900, 200)]
    ]);
    const { fake, calls } = bucket(objects);
    const checked = await settleStagedDerivatives(
      {
        teamId: TEAM,
        contentId: CONTENT,
        staged: [
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            stagingKey: staging('tile')
          },
          {
            variant: 'row',
            contentType: 'image/webp',
            bytes: 23,
            width: 160,
            height: 90,
            stagingKey: staging('row')
          },
          {
            variant: 'full',
            contentType: 'image/webp',
            bytes: 200,
            width: 1600,
            height: 901,
            stagingKey: staging('full')
          },
          {
            variant: 'poster',
            contentType: 'image/webp',
            bytes: 64,
            width: 10,
            height: 10,
            stagingKey: staging('poster')
          }
        ]
      },
      fake,
      new AbortController().signal
    );
    expect(checked.map(item => [item.variant, item.accepted, item.reason ?? null])).toEqual([
      ['tile', true, null],
      ['row', false, 'type'],
      ['full', false, 'dimensions'],
      ['poster', false, 'missing']
    ]);
    expect(calls).toEqual(['copy tile -> 1/tile', 'remove tile', 'remove row', 'remove full']);
    expect(objects.has(final('tile'))).toBe(true);
    // Only the head is read, never the whole picture.
    expect(fake.rangeGet).toHaveBeenCalledWith(staging('tile'), 0, 63, expect.anything());
  });

  it('a retried complete finds its picture already moved and counts it', async () => {
    const objects = new Map<string, Uint8Array>([[final('tile'), webp(480, 270)]]);
    const { fake } = bucket(objects);
    const [checked] = await settleStagedDerivatives(
      {
        teamId: TEAM,
        contentId: CONTENT,
        staged: [
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            stagingKey: staging('tile')
          }
        ]
      },
      fake,
      new AbortController().signal
    );
    expect(checked).toMatchObject({ variant: 'tile', accepted: true });
  });
});

describe('the upload routes carry them', () => {
  const context = {
    member: true,
    storageBackend: 'r2',
    storagePilot: true,
    actorPilot: true,
    workspaceAllowed: true,
    archived: false,
    allowed: true,
    accessEpoch: '0',
    contentRevision: '0',
    rootMaterialId: id(9)
  };
  const session = (derivatives: unknown[] = []) => ({
    kind: 'session',
    uploadId: UPLOAD,
    partBytes: 16 * 1024 * 1024,
    partCount: 1,
    derivativeSlots: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    state: 'completing',
    r2UploadId: 'r2-1',
    objectKey: `t/${TEAM}/o/${CONTENT}`,
    declaredContentId: CONTENT,
    declaredBytes: '3',
    objectEtag: null,
    resultMaterialId: null,
    name: 'Clip.mp4',
    contentType: 'video/mp4',
    teamId: TEAM,
    derivatives
  });
  function uploadDeps(rpc: UploadDeps['rpc'], objects = new Map<string, Uint8Array>()): UploadDeps {
    const { fake } = bucket(objects);
    return {
      actorId: ACTOR,
      rpc,
      bucket: {
        ...fake,
        createMultipart: vi.fn(async () => 'r2-1'),
        signPart: vi.fn(),
        listParts: vi.fn(async () => {
          throw new TeamFunctionError('NOT_FOUND', { retryable: false });
        }),
        completeMultipart: vi.fn(),
        abortMultipart: vi.fn(),
        head: vi.fn(async key =>
          key === `t/${TEAM}/o/${CONTENT}`
            ? { bytes: 3, etag: '"x-1"', contentType: 'video/mp4' }
            : fake.head(key, new AbortController().signal)
        )
      } as unknown as UploadDeps['bucket'],
      journal: async () => true,
      operationId: id(10),
      client: { kind: 'web', version: '1.8.0+110' }
    };
  }

  it('admit names what to make by the category of the file', async () => {
    const rpc = vi.fn(async (name: string) =>
      name === 'service_space_storage_context'
        ? context
        : { ...session(), state: 'open', r2UploadId: 'r2-1' }
    );
    const answer = await admitUpload(
      parseAdmitCommand({
        teamId: TEAM,
        parentMaterialId: null,
        name: 'Clip.mp4',
        contentType: 'video/mp4',
        bytes: '3',
        contentId: CONTENT,
        ingress: 'explorer',
        idempotencyKey: 'k'.repeat(20)
      }),
      uploadDeps(rpc)
    );
    expect(answer).toMatchObject({
      kind: 'session',
      derivativeSlots: ['row', 'tile', 'full', 'poster', 'sprite']
    });
  });

  it('declare signs one staging PUT per picture, with the category the server worked out', async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_space_storage_context') return context;
      if (name === 'service_space_upload_session') return { ...session(), state: 'open' };
      if (name === 'service_declare_space_upload_derivatives') {
        expect((args.p_input as { category: string }).category).toBe('video');
        return [{ variant: 'tile', stagingKey: staging('tile') }];
      }
      throw new Error(name);
    });
    const result = await declareDerivatives(
      UPLOAD,
      {
        teamId: TEAM,
        derivatives: [
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            md5: 'a'.repeat(32)
          }
        ],
        media: { durationMs: 1000, width: 1080, height: 1920, codec: null, fps: null },
        unsupported: false
      },
      uploadDeps(rpc)
    );
    expect(result.derivatives).toEqual([
      expect.objectContaining({
        variant: 'tile',
        contentType: 'image/webp',
        url: expect.stringContaining(`/u/${UPLOAD}/tile`)
      })
    ]);
  });

  it('complete commits only the checked pictures', async () => {
    const objects = new Map<string, Uint8Array>([
      [staging('tile'), webp(480, 270)],
      [staging('poster'), jpeg(1, 1)]
    ]);
    let committed: unknown = null;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_space_storage_context') return context;
      if (name === 'service_space_upload_session')
        return session([
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            md5: 'a'.repeat(32),
            stagingKey: staging('tile')
          },
          {
            variant: 'poster',
            contentType: 'image/webp',
            bytes: 23,
            width: 1,
            height: 1,
            md5: 'b'.repeat(32),
            stagingKey: staging('poster')
          }
        ]);
      if (name === 'service_complete_space_upload') {
        committed = args.p_input;
        return {
          id: MATERIAL,
          teamId: TEAM,
          parentMaterialId: null,
          name: 'Clip.mp4',
          kind: 'file',
          lifecycle: 'active',
          materialRevision: '0',
          contentId: CONTENT,
          sizeBytes: '3',
          mimeType: 'video/mp4'
        };
      }
      throw new Error(name);
    });
    await completeUpload(UPLOAD, { teamId: TEAM }, uploadDeps(rpc, objects));
    expect((committed as { derivatives: unknown[] }).derivatives).toEqual([
      {
        variant: 'tile',
        contentType: 'image/webp',
        bytes: 64,
        width: 480,
        height: 270,
        accepted: true
      },
      {
        variant: 'poster',
        contentType: 'image/webp',
        bytes: 23,
        width: 1,
        height: 1,
        accepted: false,
        reason: 'type'
      }
    ]);
  });
});

describe('an agent backfills under a lease', () => {
  const lease = 'L'.repeat(43);
  function deps(
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    objects = new Map<string, Uint8Array>()
  ) {
    return {
      actorId: null,
      rpc,
      bucket: bucket(objects).fake,
      journal: async () => true,
      operationId: id(11),
      client: { kind: 'agent' as const, version: '1.8.0+110' }
    };
  }
  const leaseRow = {
    objectId: OBJECT,
    claimId: CLAIM,
    contentId: CONTENT,
    contentType: 'video/quicktime',
    category: 'video',
    slots: ['row', 'tile', 'full', 'poster', 'sprite'],
    teamId: TEAM
  };

  it('the page claims a job: the lease is stored only as its hash, the source as a ticket', async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      seen[name] = args;
      if (name === 'service_space_storage_context')
        return {
          member: true,
          storageBackend: 'r2',
          storagePilot: false,
          actorPilot: true,
          workspaceAllowed: true,
          archived: false,
          allowed: true,
          accessEpoch: '0',
          contentRevision: '0',
          rootMaterialId: null
        };
      if (name === 'service_claim_space_derivative_jobs')
        return {
          jobs: [
            {
              objectId: OBJECT,
              materialId: MATERIAL,
              name: 'Phone.mov',
              category: 'video',
              contentId: CONTENT,
              contentType: 'video/quicktime',
              bytes: '9',
              reason: 'browser_unsupported',
              made: [],
              needsMediaFacts: true,
              leaseUntil: '2099-01-01T00:00:00Z'
            }
          ]
        };
      if (name === 'service_read_space_materials')
        return [
          {
            id: MATERIAL,
            teamId: TEAM,
            parentMaterialId: null,
            name: 'Phone.mov',
            kind: 'file',
            lifecycle: 'active',
            materialRevision: '0',
            contentId: CONTENT,
            sizeBytes: '9',
            mimeType: 'video/quicktime'
          }
        ];
      if (name === 'issue_team_transfer_grant') return null;
      throw new Error(name);
    });
    const { job } = await claimDerivativeJob(
      { teamId: TEAM },
      { ...deps(rpc), actorId: ACTOR, token: () => lease }
    );
    expect(job).toMatchObject({
      objectId: OBJECT,
      leaseToken: lease,
      source: { purpose: 'download_range' }
    });
    expect(seen.service_claim_space_derivative_jobs!.p_lease_hash).toBe(await leaseHash(lease));
    expect(JSON.stringify(seen)).not.toContain(lease);
  });

  it('stages only the variants the lease allows, under its claim', async () => {
    const rpc = vi.fn(async () => leaseRow);
    const result = await stageAgentDerivatives(
      {
        teamId: TEAM,
        objectId: OBJECT,
        leaseToken: lease,
        derivatives: [
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            md5: 'a'.repeat(32)
          }
        ]
      },
      deps(rpc)
    );
    expect(result.derivatives[0]!.url).toContain(`/u/${CLAIM}/tile`);
    await expect(
      stageAgentDerivatives(
        { teamId: TEAM, objectId: OBJECT, leaseToken: 'short', derivatives: [] },
        deps(rpc)
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('finish passes on what passed the check; pictures all refused are a failed attempt', async () => {
    const objects = new Map<string, Uint8Array>([[staging('tile', CLAIM), webp(480, 270)]]);
    const finished: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'service_space_derivative_lease') return leaseRow;
      finished.push(args.p_input as Record<string, unknown>);
      return { state: 'ready' };
    });
    const media = { durationMs: 5000, width: 1080, height: 1920, codec: 'hevc', fps: 29.97 };
    await finishAgentDerivative(
      {
        teamId: TEAM,
        objectId: OBJECT,
        leaseToken: lease,
        outcome: 'ready',
        media,
        derivatives: [
          {
            variant: 'tile',
            contentType: 'image/webp',
            bytes: 64,
            width: 480,
            height: 270,
            md5: 'a'.repeat(32)
          }
        ]
      },
      deps(rpc, objects)
    );
    expect(finished[0]).toMatchObject({
      outcome: 'ready',
      media,
      derivatives: [{ variant: 'tile', width: 480 }]
    });
    await finishAgentDerivative(
      {
        teamId: TEAM,
        objectId: OBJECT,
        leaseToken: lease,
        outcome: 'ready',
        derivatives: [
          {
            variant: 'row',
            contentType: 'image/webp',
            bytes: 64,
            width: 160,
            height: 90,
            md5: 'a'.repeat(32)
          }
        ]
      },
      deps(rpc, objects)
    );
    expect(finished[1]).toMatchObject({
      outcome: 'failed',
      errorCode: 'DERIVATIVE_REJECTED',
      derivatives: []
    });
  });
});
