/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import { verifyAnonymousImage } from '../supabase/functions/_shared/catalog-image-sharing.js';
import {
  createCreativeImagePublisher,
  parseCreativeImageReservation
} from '../supabase/functions/drive-ops/creative-images.js';
import { sweepCreativeImages } from '../supabase/functions/catalog-images/worker.js';
import { createDurableProductCatalog } from '../supabase/functions/drive-ops/catalog-durable.js';

/**
 * 062 (R7, R29, R33, T049/T054/T087): a Launch's image creative reaches H only through a link
 * a signed-out reader has been seen to fetch — an R2 `c1/` copy read back byte for byte, or
 * Drive's own picture link read anonymously.
 */

const TEAM = '62000000-0000-4000-8000-0000000004aa';
const ACTOR = '62000000-0000-4000-8000-0000000004bb';
const IMAGE = '62000000-0000-4000-8000-0000000004cc';
const KEY = 'c1/62000000-0000-4000-8000-0000000004dd';
const PUBLIC = `https://images.example.test/${KEY}`;

const material = {
  id: '62000000-0000-4000-8000-000000000401',
  name: 'photo.jpg',
  category: 'image',
  driveFileId: 'drive-photo',
  resourceKey: null,
  parentFolderId: 'folder',
  credentialId: 'cred'
};
const live = {
  id: 'drive-photo',
  mimeType: 'image/jpeg',
  resourceKey: 'rk',
  version: '7',
  checksum: 'a'.repeat(32),
  size: 2048
};
const optimized = {
  bytes: new Uint8Array([1, 2, 3]),
  image: { mime: 'image/jpeg', sha256: 'b'.repeat(64) }
};

function setup(
  options: { reservation?: unknown; optimizeError?: TeamFunctionError; verifyFails?: boolean } = {}
) {
  const calls: string[] = [];
  const service = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'service_reserve_launch_creative_image')
        return {
          data: options.reservation ?? { state: 'reserved', id: IMAGE, objectKey: KEY },
          error: null
        };
      if (name === 'service_commit_launch_creative_image')
        return { data: { id: args.p_id, url: args.p_url }, error: null };
      if (name === 'service_fail_launch_creative_image') return { data: null, error: null };
      throw Error('Unexpected RPC ' + name);
    })
  };
  const r2 = {
    putFinal: vi.fn(async () => 'created'),
    verify: vi.fn(async () => {
      if (options.verifyFails) throw new TeamFunctionError('IMAGE_PUBLIC_VERIFICATION_FAILED');
    }),
    publicUrl: vi.fn((key: string) => `https://images.example.test/${key}`)
  };
  const readMaterial = vi.fn(async () => new Uint8Array([9, 9, 9]));
  const optimize = vi.fn(async () => {
    if (options.optimizeError) throw options.optimizeError;
    return optimized;
  });
  const verifyAnonymous = vi.fn(async () => ({ mime: 'image/jpeg', size: 3 }));
  const publish = createCreativeImagePublisher({
    service,
    r2,
    readMaterial,
    optimize,
    verifyAnonymous
  });
  return { publish, service, r2, readMaterial, optimize, verifyAnonymous, calls };
}

const input = (copyToR2: boolean) => ({
  teamId: TEAM,
  actorId: ACTOR,
  copyToR2,
  images: [{ ordinal: 0, material, live, drive: {} }]
});

describe('the R2 path', () => {
  it('reserves, reads with proof, optimizes, writes once, reads back, commits', async () => {
    const f = setup();
    await expect(f.publish(input(true))).resolves.toEqual([
      { ordinal: 0, link: PUBLIC, linkKind: 'r2', imageId: IMAGE }
    ]);
    expect(f.calls).toEqual([
      'service_reserve_launch_creative_image',
      'service_commit_launch_creative_image'
    ]);
    expect(f.service.rpc.mock.calls[0][1]).toMatchObject({
      p_team: TEAM,
      p_material: material.id,
      p_version: '7',
      p_checksum: 'a'.repeat(32)
    });
    expect(f.readMaterial).toHaveBeenCalledWith(
      TEAM,
      ACTOR,
      material.id,
      {
        fileId: 'drive-photo',
        resourceKey: 'rk',
        version: '7',
        checksum: 'a'.repeat(32),
        size: 2048
      },
      expect.anything()
    );
    expect(f.r2.putFinal).toHaveBeenCalledWith(
      KEY,
      optimized.bytes,
      'image/jpeg',
      expect.anything(),
      'b'.repeat(64)
    );
    // The read-back is anonymous (publicRead = true), byte for byte.
    expect(f.r2.verify).toHaveBeenCalledWith(
      KEY,
      optimized.bytes,
      'image/jpeg',
      expect.anything(),
      true
    );
    expect(f.service.rpc.mock.calls[1][1]).toMatchObject({
      p_id: IMAGE,
      p_url: PUBLIC,
      p_mime: 'image/jpeg',
      p_size: 3
    });
  });

  it('reuses a published version once a signed-out reader still gets it', async () => {
    const f = setup({ reservation: { state: 'ready', id: IMAGE, url: PUBLIC } });
    await expect(f.publish(input(true))).resolves.toEqual([
      { ordinal: 0, link: PUBLIC, linkKind: 'r2', imageId: IMAGE }
    ]);
    expect(f.verifyAnonymous).toHaveBeenCalledWith(PUBLIC, expect.anything());
    expect(f.readMaterial).not.toHaveBeenCalled();
    expect(f.r2.putFinal).not.toHaveBeenCalled();
  });

  it('names a picture the optimizer refuses and releases its reservation', async () => {
    const small = setup({
      optimizeError: new TeamFunctionError('IMAGE_DIMENSIONS_INVALID', { retryable: false })
    });
    await expect(small.publish(input(true))).rejects.toMatchObject({
      code: 'CREATIVE_IMAGE_FORMAT',
      retryable: false
    });
    expect(small.calls).toContain('service_fail_launch_creative_image');
    const large = setup({ optimizeError: new TeamFunctionError('IMAGE_TOO_LARGE') });
    await expect(large.publish(input(true))).rejects.toMatchObject({
      code: 'CREATIVE_IMAGE_TOO_LARGE'
    });
    expect(small.r2.putFinal).not.toHaveBeenCalled();
  });

  it('leaves an unproven public read retryable and uncommitted', async () => {
    const f = setup({ verifyFails: true });
    await expect(f.publish(input(true))).rejects.toMatchObject({
      code: 'PUBLIC_READ_UNVERIFIED',
      retryable: true
    });
    expect(f.calls).not.toContain('service_commit_launch_creative_image');
  });

  it('refuses a file without a proven version', async () => {
    const f = setup();
    await expect(
      f.publish({
        ...input(true),
        images: [{ ordinal: 0, material, live: { ...live, checksum: null }, drive: {} }]
      })
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.calls).toEqual([]);
  });

  it('reads only reservations of the c1 shape', () => {
    expect(() =>
      parseCreativeImageReservation({ state: 'reserved', id: IMAGE, objectKey: 'v1/x' })
    ).toThrow('INVALID_RESPONSE');
    expect(() =>
      parseCreativeImageReservation({ state: 'ready', id: IMAGE, url: `${PUBLIC}?signed=1` })
    ).toThrow('INVALID_RESPONSE');
  });
});

describe('the Drive path', () => {
  it('links Drive’s own picture and proves a signed-out reader gets it', async () => {
    const f = setup();
    const [link] = await f.publish(input(false));
    expect(link).toEqual({
      ordinal: 0,
      link: 'https://drive.google.com/uc?export=view&id=drive-photo&resourcekey=rk',
      linkKind: 'drive'
    });
    expect(f.verifyAnonymous).toHaveBeenCalledWith(link.link, expect.anything());
    expect(f.calls).toEqual([]);
  });
});

describe('verifyAnonymousImage', () => {
  const image = () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } });

  it('reads without credentials and accepts an image body', async () => {
    const fetcher = vi.fn(async () => image());
    await expect(verifyAnonymousImage(PUBLIC, { fetcher })).resolves.toEqual({
      mime: 'image/png',
      size: 4
    });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' });
  });

  it('waits for a grant that is still settling, then gives up retryably', async () => {
    const sleep = vi.fn(async () => undefined);
    const signIn = () =>
      new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
    const settling = vi.fn().mockResolvedValueOnce(signIn()).mockResolvedValueOnce(image());
    await expect(verifyAnonymousImage(PUBLIC, { fetcher: settling, sleep })).resolves.toMatchObject(
      {
        size: 4
      }
    );
    const never = vi.fn(async () => signIn());
    await expect(verifyAnonymousImage(PUBLIC, { fetcher: never, sleep })).rejects.toMatchObject({
      code: 'PUBLIC_READ_UNVERIFIED',
      retryable: true
    });
    expect(never).toHaveBeenCalledTimes(3);
  });

  it('refuses an empty body, an error status and a non-https link', async () => {
    const sleep = async () => undefined;
    const empty = vi.fn(
      async () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })
    );
    await expect(verifyAnonymousImage(PUBLIC, { fetcher: empty, sleep })).rejects.toMatchObject({
      code: 'PUBLIC_READ_UNVERIFIED'
    });
    const missing = vi.fn(
      async () => new Response('x', { status: 404, headers: { 'content-type': 'image/png' } })
    );
    await expect(verifyAnonymousImage(PUBLIC, { fetcher: missing, sleep })).rejects.toMatchObject({
      code: 'PUBLIC_READ_UNVERIFIED'
    });
    await expect(verifyAnonymousImage('http://images.example.test/x.png')).rejects.toMatchObject({
      code: 'PUBLIC_READ_UNVERIFIED',
      retryable: false
    });
  });
});

describe('the c1 sweep', () => {
  it('removes a retired object and marks it purged only after removal', async () => {
    const calls: string[] = [];
    const service = {
      rpc: vi.fn(async (name: string) => {
        calls.push(name);
        if (name === 'service_sweep_launch_creative_images')
          return {
            data: [
              { id: IMAGE, object_key: KEY },
              { id: IMAGE, object_key: 'v1/not-ours' }
            ],
            error: null
          };
        return { data: null, error: null };
      })
    };
    const r2 = { remove: vi.fn(async () => undefined) };
    await expect(sweepCreativeImages({ service, r2 }, new AbortController().signal)).resolves.toBe(
      1
    );
    expect(r2.remove).toHaveBeenCalledWith('public', KEY, expect.anything());
    expect(calls).toEqual([
      'service_sweep_launch_creative_images',
      'service_mark_launch_creative_image_purged'
    ]);
  });

  it('keeps an object it could not remove and never blocks the pool', async () => {
    const service = {
      rpc: vi.fn(async () => ({ data: [{ id: IMAGE, object_key: KEY }], error: null }))
    };
    const r2 = {
      remove: vi.fn(async () => Promise.reject(new TeamFunctionError('IMAGE_WRITE_UNCERTAIN')))
    };
    await expect(sweepCreativeImages({ service, r2 }, new AbortController().signal)).resolves.toBe(
      0
    );
    expect(service.rpc).toHaveBeenCalledTimes(1);
    const broken = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'missing function' } }))
    };
    await expect(
      sweepCreativeImages({ service: broken, r2 }, new AbortController().signal)
    ).resolves.toBe(0);
  });
});

describe('the durable image step', () => {
  const M = (n: number) => `62000000-0000-4000-8000-00000000050${n}`;
  function metadata(overrides = {}) {
    return {
      id: 'drive-file',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      parents: ['folder'],
      trashed: false,
      driveId: null,
      resourceKey: null,
      shortcutTargetId: null,
      shortcutTargetResourceKey: null,
      capabilities: {
        canDownload: true,
        canShare: true,
        canModifyContent: true,
        canAddChildren: true
      },
      size: 10,
      modifiedAt: null,
      version: '1',
      checksum: 'c'.repeat(32),
      webViewLink: null,
      thumbnailLink: null,
      appProperties: {},
      ...overrides
    };
  }
  function harness(checkpoint: Record<string, unknown> = {}) {
    const saved: Record<string, unknown> = { ...checkpoint };
    const intent = {
      id: '62000000-0000-4000-8000-0000000005ff',
      variant: 1,
      state: 'reserved',
      fence: 'f',
      attempt: 1,
      checkpoint: saved,
      result: null,
      operationId: null
    };
    const store = {
      begin: vi.fn(async () => intent),
      checkpoint: vi.fn(async (current, _owner, state, patch) => {
        Object.assign(saved, patch);
        current.state = state;
        current.checkpoint = { ...current.checkpoint, ...patch };
      }),
      permission: vi.fn(async () => undefined)
    };
    const drive = {
      listAnyonePermissions: vi.fn(async () => []),
      createAnyoneReaderPermission: vi.fn(async () => ({ id: 'p', role: 'reader' })),
      createConvertedFile: vi.fn(async input =>
        metadata({
          id: 'sheet',
          name: input.name,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink: 'https://docs.google.com/spreadsheets/d/sheet/edit',
          appProperties: input.appProperties
        })
      ),
      updateFileMetadata: vi.fn(async () => metadata()),
      getFile: vi.fn(async () => metadata()),
      findCatalogIntentFiles: vi.fn(async () => [])
    };
    drive.listAnyonePermissions.mockImplementation(async (fileId: string) =>
      fileId === 'sheet' && drive.createAnyoneReaderPermission.mock.calls.length
        ? [{ id: 'p', role: 'reader' }]
        : []
    );
    const published: number[] = [];
    const deps = {
      initialVideoAuthority: {
        serverNow: async () => Date.now(),
        prepare: vi.fn(),
        registerCreated: vi.fn(async () => undefined)
      },
      loadVideo: vi.fn(async ({ videoId }) => ({
        id: videoId,
        name: `photo-${videoId.slice(-1)}.jpg`,
        category: 'image',
        driveFileId: `drive-${videoId.slice(-1)}`,
        resourceKey: null,
        parentFolderId: 'folder',
        credentialId: 'cred'
      })),
      resolveRestitchedVideo: vi.fn(),
      readSettings: vi.fn(async () => ({
        title: 'Polo',
        description: 'Knit',
        imageLink: 'https://img.example.test/white.png',
        priceMin: 10,
        priceMax: 10
      })),
      drawTexts: vi.fn(async () => []),
      drawImages: vi.fn(async () => []),
      readLiveCatalogs: vi.fn(async () => []),
      nextVariant: vi.fn(async () => 1),
      driveFor: vi.fn(async () => drive),
      proveVideo: vi.fn(async video => metadata({ id: video.driveFileId, name: video.name })),
      destination: vi.fn(async () => ({
        materialId: null,
        live: metadata({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
      })),
      planName: vi.fn(async ({ name }) => ({ name, reservationKey: name })),
      startOperation: vi.fn(async () => ({ operationId: 'op', state: 'pending', reused: false })),
      bindIntent: vi.fn(async () => undefined),
      markRunning: vi.fn(async () => undefined),
      failOperation: vi.fn(async () => undefined),
      finalize: vi.fn(async () => ({ materialId: '62000000-0000-4000-8000-0000000005cc' })),
      link: vi.fn(async () => ({ linked: true, retired: [] })),
      publishCreativeImages: vi.fn(async ({ images }) =>
        images.map(image => {
          published.push(image.ordinal);
          return {
            ordinal: image.ordinal,
            link: `https://images.example.test/c1/${image.ordinal}.jpg`,
            linkKind: 'r2',
            imageId: `62000000-0000-4000-8000-00000000060${image.ordinal}`
          };
        })
      ),
      confirmCreativeImageUses: vi.fn(async () => undefined),
      log: vi.fn()
    };
    return { store, deps, drive, saved, published };
  }
  const body = {
    teamId: '62000000-0000-4000-8000-0000000005aa',
    videoMaterialId: M(1),
    sourceLink: 'https://offer.example.test/',
    productCount: 3,
    replacesMaterialId: null,
    restitchOperationId: null,
    idempotencyKey: 'launch:62000000-0000-4000-8000-0000000005ee:catalog',
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' },
    copyVideoToR2: true,
    creativeKind: 'image',
    creatives: [
      { materialId: M(1), alias: 'pic1', copies: 2 },
      { materialId: M(2), alias: 'pic2', copies: 1 }
    ]
  };

  it('checkpoints every image and confirms the catalog’s uses at registration', async () => {
    const h = harness();
    const result = await createDurableProductCatalog(
      h.deps,
      h.store,
      async () => h.drive,
      body,
      ACTOR
    );
    expect(result.outcome).toBe('created');
    expect(h.published).toEqual([0, 1]);
    expect(h.saved.creativeImage_0).toEqual({
      id: '62000000-0000-4000-8000-000000000600',
      url: 'https://images.example.test/c1/0.jpg',
      linkKind: 'r2'
    });
    expect(h.deps.confirmCreativeImageUses).toHaveBeenCalledWith(
      '62000000-0000-4000-8000-0000000005cc',
      ['62000000-0000-4000-8000-000000000600', '62000000-0000-4000-8000-000000000601']
    );
    const plan = h.saved.initialVideoPlan;
    expect(plan.segments.map(segment => [segment.kind, segment.rowCount])).toEqual([
      ['image', 2],
      ['image', 1]
    ]);
  });

  it('never publishes an image again after a restart', async () => {
    const h = harness({
      creativeImage_0: {
        id: '62000000-0000-4000-8000-000000000600',
        url: 'https://images.example.test/c1/0.jpg',
        linkKind: 'r2'
      }
    });
    await createDurableProductCatalog(h.deps, h.store, async () => h.drive, body, ACTOR);
    expect(h.published).toEqual([1]);
  });
});

describe('a failed image in the durable step', () => {
  it('records which creative stopped the catalog, by ordinal only', async () => {
    const saved: Record<string, unknown> = {};
    const intent = {
      id: '62000000-0000-4000-8000-0000000007ff',
      variant: 1,
      state: 'reserved',
      fence: 'f',
      attempt: 1,
      checkpoint: saved,
      result: null,
      operationId: null
    };
    const store = {
      begin: vi.fn(async () => intent),
      checkpoint: vi.fn(async (current, _owner, state, patch) => {
        Object.assign(saved, patch);
        current.state = state;
        current.checkpoint = { ...current.checkpoint, ...patch };
      }),
      permission: vi.fn(async () => undefined)
    };
    const failing = vi.fn(async ({ images }) => {
      if (images[0].ordinal === 1)
        throw new TeamFunctionError('CREATIVE_IMAGE_FORMAT', { retryable: false });
      return [{ ordinal: 0, link: 'https://images.example.test/c1/0.jpg', linkKind: 'r2' }];
    });
    const M = (n: number) => `62000000-0000-4000-8000-00000000070${n}`;
    const live = (video: { driveFileId: string; name: string }) => ({
      id: video.driveFileId,
      name: video.name,
      mimeType: 'image/jpeg',
      parents: ['folder'],
      trashed: false,
      resourceKey: null,
      capabilities: { canDownload: true, canShare: true },
      version: '1',
      checksum: 'c'.repeat(32),
      size: 10,
      modifiedAt: null,
      appProperties: {}
    });
    const providerDrive = {
      listAnyonePermissions: vi.fn(async () => []),
      getFile: vi.fn(async () => live({ driveFileId: 'x', name: 'x' }))
    };
    const deps = {
      initialVideoAuthority: {
        serverNow: async () => Date.now(),
        prepare: vi.fn(),
        registerCreated: vi.fn()
      },
      loadVideo: vi.fn(async ({ videoId }) => ({
        id: videoId,
        name: 'p.jpg',
        category: 'image',
        driveFileId: `drive-${videoId.slice(-1)}`,
        resourceKey: null,
        parentFolderId: 'folder',
        credentialId: 'cred'
      })),
      readSettings: vi.fn(async () => ({
        title: 't',
        description: 'd',
        imageLink: 'https://w.test/x.png',
        priceMin: 1,
        priceMax: 1
      })),
      readLiveCatalogs: vi.fn(async () => []),
      driveFor: vi.fn(async () => providerDrive),
      proveVideo: vi.fn(async video => live(video)),
      destination: vi.fn(async () => ({
        materialId: null,
        live: live({ driveFileId: 'folder', name: 'f' })
      })),
      publishCreativeImages: failing,
      failOperation: vi.fn(),
      log: vi.fn()
    };
    await expect(
      createDurableProductCatalog(
        deps,
        store,
        async () => providerDrive,
        {
          teamId: '62000000-0000-4000-8000-0000000007aa',
          videoMaterialId: M(1),
          sourceLink: 'https://offer.example.test/',
          productCount: 2,
          replacesMaterialId: null,
          restitchOperationId: null,
          idempotencyKey: 'launch:62000000-0000-4000-8000-0000000007ee:catalog',
          catalogVideoProtocolVersion: 1,
          restitchEnabled: false,
          videoVariationCount: 1,
          videoPublication: { mode: 'immediate' },
          copyVideoToR2: true,
          creativeKind: 'image',
          creatives: [
            { materialId: M(1), alias: 'a', copies: 1 },
            { materialId: M(2), alias: 'b', copies: 1 }
          ]
        },
        ACTOR
      )
    ).rejects.toMatchObject({ code: 'CREATIVE_IMAGE_FORMAT' });
    expect(saved.creativeOrdinal).toBe(1);
    expect(saved.safeErrorCode).toBe('CREATIVE_IMAGE_FORMAT');
    expect(saved.creativeImage_0).toBeDefined();
  });
});
