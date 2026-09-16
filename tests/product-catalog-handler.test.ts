import { describe, expect, it, vi } from 'vitest';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type CatalogDrive,
  type ExistingCatalog,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog.js';

/**
 * Feature 022: the order `POST /drive-ops/product-catalog/create` works in.
 *
 * What matters is what is left behind. Every refusal must come before a file exists; every
 * failure after one must put it in the trash; a lost race must show the winner rather than make
 * a second sheet. Drive and the database are replaced by recording fakes so each of those can be
 * asserted as "this call happened, that one never did".
 */

const TEAM = '22000000-0000-4000-8000-000000000001';
const VIDEO = '22000000-0000-4000-8000-000000000002';
const OLD_SHEET = '22000000-0000-4000-8000-000000000003';
const NEW_SHEET = '22000000-0000-4000-8000-000000000004';
const ACTOR = '22000000-0000-4000-8000-000000000005';

const settings = {
  title: 'Polo',
  description: 'Knit',
  price: 10,
  imageLink: 'https://img.example.test/a.png'
};

function metadata(overrides: Partial<DriveFileMetadata> = {}): DriveFileMetadata {
  return {
    id: 'drive-video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    parents: ['folder'],
    trashed: false,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: {
      canDownload: true,
      canListChildren: false,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canShare: true,
      canTrash: true,
      canUntrash: true
    },
    size: 10,
    modifiedAt: null,
    version: '1',
    checksum: null,
    webViewLink: null,
    thumbnailLink: null,
    appProperties: {},
    ...overrides
  };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://offer.example.test/?sub=1',
  productCount: 3,
  replacesMaterialId: null,
  idempotencyKey: 'catalog:0001-attempt',
  ...overrides
});

const existing: ExistingCatalog = {
  materialId: OLD_SHEET,
  name: 'clip catalog',
  variant: 1,
  sheetUrl: 'https://docs.google.com/spreadsheets/d/old/edit',
  sourceLink: 'https://offer.example.test/?sub=0',
  productCount: 100,
  createdAt: '2026-09-15T00:00:00.000Z'
};

function setup(
  options: {
    category?: string;
    settings?: typeof settings | null;
    live?: ExistingCatalog | null;
    catalogs?: ExistingCatalog[];
    next?: number;
    videoPublic?: boolean;
    canShare?: boolean;
    editAllowed?: boolean;
    reused?: { state: 'succeeded' | 'running' };
    link?: Awaited<ReturnType<ProductCatalogDeps['link']>>;
    failAt?: 'create' | 'share-sheet' | 'finalize' | 'link';
  } = {}
) {
  const sheetId = 'drive-sheet';
  const anyone = new Map<string, Array<{ id: string; role: string }>>([
    ['drive-video', options.videoPublic ? [{ id: 'p', role: 'reader' }] : []],
    [sheetId, []]
  ]);
  const drive = {
    listAnyonePermissions: vi.fn(async (fileId: string) => anyone.get(fileId) ?? []),
    createAnyoneReaderPermission: vi.fn(async (fileId: string) => {
      if (options.failAt === 'share-sheet' && fileId === sheetId) {
        throw new TeamFunctionError('PERMISSION_DENIED');
      }
      anyone.set(fileId, [{ id: 'new', role: 'reader' }]);
      return { id: 'new', role: 'reader' as const };
    }),
    createConvertedFile: vi.fn(async (input: { name: string; bytes: Uint8Array }) => {
      if (options.failAt === 'create') throw new TeamFunctionError('DRIVE_UNAVAILABLE');
      return metadata({
        id: sheetId,
        name: input.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/drive-sheet/edit?usp=drivesdk',
        size: 4096
      });
    }),
    updateFileMetadata: vi.fn(async () => metadata())
  };
  const deps: ProductCatalogDeps = {
    loadVideo: vi.fn(async ({ permission }) => {
      if (permission === 'edit' && options.editAllowed === false) {
        throw new TeamFunctionError('PERMISSION_DENIED');
      }
      return {
        id: VIDEO,
        name: 'clip.mp4',
        category: options.category ?? 'video',
        driveFileId: 'drive-video',
        resourceKey: null,
        parentFolderId: 'folder',
        credentialId: 'cred'
      };
    }),
    readSettings: vi.fn(async () => (options.settings === undefined ? settings : options.settings)),
    readLiveCatalogs: vi.fn(async () => options.catalogs ?? (options.live ? [options.live] : [])),
    nextVariant: vi.fn(async () => options.next ?? 1),
    driveFor: vi.fn(async () => drive as unknown as CatalogDrive),
    proveVideo: vi.fn(async () =>
      metadata({ capabilities: { ...metadata().capabilities, canShare: options.canShare ?? true } })
    ),
    destination: vi.fn(async () => ({
      materialId: null,
      live: metadata({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
    })),
    planName: vi.fn(async ({ name }) => ({ name, reservationKey: name })),
    startOperation: vi.fn(async () => ({
      operationId: 'op',
      state: options.reused?.state ?? ('pending' as const),
      reused: Boolean(options.reused)
    })),
    bindIntent: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    failOperation: vi.fn(async () => undefined),
    finalize: vi.fn(async () => {
      if (options.failAt === 'finalize') throw new TeamFunctionError('WRONG_STATE');
      return { materialId: NEW_SHEET };
    }),
    link: vi.fn(async () => {
      if (options.failAt === 'link') throw new TeamFunctionError('INVALID_RESPONSE');
      return options.link ?? { linked: true as const, retired: [] };
    }),
    log: vi.fn()
  };
  return { deps, drive };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as TeamFunctionError;
  }
  throw new Error('expected a refusal');
}

describe('reading the request', () => {
  it.each([
    [{ sourceLink: '   ' }, 'link'],
    [{ productCount: 0 }, 'count'],
    [{ productCount: 401 }, 'count'],
    [{ productCount: 2.5 }, 'count'],
    [{ productCount: '3' }, 'count']
  ])('refuses %j naming the field', async (patch, field) => {
    const error = await refusal(
      Promise.resolve().then(() => parseCreateProductCatalogRequest(body(patch)))
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toEqual({ field });
  });

  it('refuses a field it does not know and a malformed id', async () => {
    expect(
      (
        await refusal(
          Promise.resolve().then(() => parseCreateProductCatalogRequest(body({ extra: 1 })))
        )
      ).code
    ).toBe('INVALID_INPUT');
    expect(
      (
        await refusal(
          Promise.resolve().then(() =>
            parseCreateProductCatalogRequest(body({ videoMaterialId: 'x' }))
          )
        )
      ).code
    ).toBe('INVALID_INPUT');
  });
});

describe('refusals leave nothing behind', () => {
  it('refuses an empty link before touching Drive', async () => {
    const { deps, drive } = setup();
    const error = await refusal(createProductCatalog(deps, body({ sourceLink: ' ' }), ACTOR));
    expect(error.details).toEqual({ field: 'link' });
    expect(deps.loadVideo).not.toHaveBeenCalled();
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
  });

  it('refuses a material that is not a video', async () => {
    const { deps, drive } = setup({ category: 'image' });
    const error = await refusal(createProductCatalog(deps, body(), ACTOR));
    expect(error.code).toBe('WRONG_STATE');
    expect(error.details).toEqual({ reason: 'not_a_video' });
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
  });

  it('refuses a space without catalog settings', async () => {
    const { deps, drive } = setup({ settings: null });
    const error = await refusal(createProductCatalog(deps, body(), ACTOR));
    expect(error.details).toEqual({ reason: 'settings_missing' });
    expect(deps.driveFor).not.toHaveBeenCalled();
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
  });

  it('refuses a video Drive will not share, before any sheet exists', async () => {
    const { deps, drive } = setup({ canShare: false });
    const error = await refusal(createProductCatalog(deps, body(), ACTOR));
    expect(error.code).toBe('SHARE_NOT_ALLOWED');
    expect(drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
    expect(deps.startOperation).not.toHaveBeenCalled();
  });

  it('asks for edit on the video only when it has to open it', async () => {
    const shut = setup({ editAllowed: false });
    expect((await refusal(createProductCatalog(shut.deps, body(), ACTOR))).code).toBe(
      'PERMISSION_DENIED'
    );
    expect(shut.drive.createConvertedFile).not.toHaveBeenCalled();

    const open = setup({ editAllowed: false, videoPublic: true });
    const result = await createProductCatalog(open.deps, body(), ACTOR);
    expect(result.outcome).toBe('created');
    expect(result.videoShared).toBe(false);
  });
});

describe('making a catalog', () => {
  it('shares the video, uploads one converted workbook, shares it and links it', async () => {
    const { deps, drive } = setup();
    const result = await createProductCatalog(deps, body(), ACTOR);

    expect(result).toMatchObject({
      outcome: 'created',
      videoShared: true,
      catalog: {
        materialId: NEW_SHEET,
        name: 'clip_v1_catalog',
        sheetUrl: 'https://docs.google.com/spreadsheets/d/drive-sheet/edit?usp=drivesdk',
        productCount: 3,
        variant: 1
      }
    });
    expect(drive.createConvertedFile).toHaveBeenCalledTimes(1);
    const upload = drive.createConvertedFile.mock.calls[0]![0] as unknown as {
      name: string;
      parentId: string;
      targetMimeType: string;
      sourceMimeType: string;
    };
    expect(upload).toMatchObject({
      name: 'clip_v1_catalog',
      parentId: 'folder',
      targetMimeType: 'application/vnd.google-apps.spreadsheet',
      sourceMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    expect(drive.createAnyoneReaderPermission).toHaveBeenCalledWith('drive-video');
    expect(drive.createAnyoneReaderPermission).toHaveBeenCalledWith('drive-sheet');
    expect(deps.link).toHaveBeenCalledWith(
      expect.objectContaining({
        companionId: NEW_SHEET,
        replaces: null,
        record: expect.objectContaining({
          productCount: 3,
          videoLink: 'https://drive.google.com/file/d/drive-video/view?usp=sharing',
          settingsSnapshot: settings,
          createdBy: ACTOR,
          variant: 1
        })
      })
    );
    expect(drive.updateFileMetadata).not.toHaveBeenCalled();
    // Drive sizes a native spreadsheet once it exists; the intent carries what Drive reported.
    expect(deps.bindIntent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clip_v1_catalog', sizeBytes: 4096 })
    );
  });

  it('makes a new variation beside the catalog that exists, named with its number (024)', async () => {
    const { deps, drive } = setup({ live: existing, next: 2 });
    const result = await createProductCatalog(
      deps,
      body({ sourceLink: 'https://offer.example.test/?sub=2' }),
      ACTOR
    );
    expect(result).toMatchObject({
      outcome: 'created',
      catalog: { name: 'clip_v2_catalog', variant: 2 }
    });
    expect(drive.createConvertedFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clip_v2_catalog' })
    );
    expect(deps.link).toHaveBeenCalledWith(
      expect.objectContaining({ replaces: null, record: expect.objectContaining({ variant: 2 }) })
    );
  });

  it('trashes its own sheet and shows the winner when it loses the race', async () => {
    const { deps, drive } = setup({ link: { linked: false, reason: 'EXISTS', existing } });
    const result = await createProductCatalog(deps, body(), ACTOR);
    expect(result.outcome).toBe('existing');
    expect(result.catalog).toEqual(existing);
    expect(drive.updateFileMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'drive-sheet', trashed: true })
    );
  });

  it.each(['share-sheet', 'finalize', 'link'] as const)(
    'rolls the sheet back when %s fails after it was created',
    async failAt => {
      const { deps, drive } = setup({ failAt });
      await refusal(createProductCatalog(deps, body(), ACTOR));
      expect(drive.updateFileMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'drive-sheet', trashed: true })
      );
      expect(deps.failOperation).toHaveBeenCalledWith('op', expect.anything());
    }
  );

  it('marks the operation failed when the upload itself fails, with nothing to trash', async () => {
    const { deps, drive } = setup({ failAt: 'create' });
    expect((await refusal(createProductCatalog(deps, body(), ACTOR))).code).toBe(
      'DRIVE_UNAVAILABLE'
    );
    expect(drive.updateFileMetadata).not.toHaveBeenCalled();
    expect(deps.failOperation).toHaveBeenCalledTimes(1);
  });

  it('does not upload twice for a confirmation that arrives twice', async () => {
    const finished = setup({ reused: { state: 'succeeded' } });
    vi.mocked(finished.deps.readLiveCatalogs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...existing, materialId: NEW_SHEET }]);
    const result = await createProductCatalog(finished.deps, body(), ACTOR);
    expect(result.catalog.materialId).toBe(NEW_SHEET);
    expect(finished.drive.createConvertedFile).not.toHaveBeenCalled();

    const inFlight = setup({ reused: { state: 'running' } });
    const error = await refusal(createProductCatalog(inFlight.deps, body(), ACTOR));
    expect(error.code).toBe('WRONG_STATE');
    expect(inFlight.drive.createConvertedFile).not.toHaveBeenCalled();
  });
});

describe('re-creating a catalog', () => {
  it('replaces one variation, keeps its number, and trashes the retired file', async () => {
    const { deps, drive } = setup({
      catalogs: [
        { ...existing, driveFileId: 'drive-old' },
        { ...existing, materialId: NEW_SHEET, name: 'clip_v2_catalog', variant: 2 }
      ],
      link: { linked: true, retired: [{ driveFileId: 'drive-old', resourceKey: null }] }
    });
    const result = await createProductCatalog(
      deps,
      body({ replacesMaterialId: OLD_SHEET, productCount: 5 }),
      ACTOR
    );
    expect(result.outcome).toBe('recreated');
    // A catalog from before variations is variation 1, and its successor says so.
    expect(result.catalog).toMatchObject({ name: 'clip_v1_catalog', variant: 1 });
    expect(deps.nextVariant).not.toHaveBeenCalled();
    expect(deps.link).toHaveBeenCalledWith(expect.objectContaining({ replaces: OLD_SHEET }));
    // The successor keeps the name: the sheet it retires is no conflict.
    expect(deps.planName).toHaveBeenCalledWith(
      expect.objectContaining({ replacingDriveFileId: 'drive-old' })
    );
    expect(drive.updateFileMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'drive-old', trashed: true })
    );
  });

  it('shows the newer catalog when the one it meant to replace is already gone', async () => {
    const newer = { ...existing, materialId: NEW_SHEET };
    const { deps, drive } = setup({ live: newer });
    const result = await createProductCatalog(deps, body({ replacesMaterialId: OLD_SHEET }), ACTOR);
    expect(result).toEqual({ outcome: 'existing', catalog: newer, videoShared: false });
    expect(drive.createConvertedFile).not.toHaveBeenCalled();
  });
});
