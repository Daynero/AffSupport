import { describe, expect, it, vi } from 'vitest';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type CatalogDrive,
  type ProductCatalogDeps
} from '../supabase/functions/drive-ops/product-catalog.js';

/**
 * 050: the option on a create request. Refused before any side effect when the
 * feature is unavailable or the actor may not manage catalog settings; recorded
 * only after the catalog is registered; absent means exactly the old request.
 */
const TEAM = '50000000-0000-4000-8000-000000000501';
const VIDEO = '50000000-0000-4000-8000-000000000502';
const NEW_SHEET = '50000000-0000-4000-8000-000000000504';
const ACTOR = '50000000-0000-4000-8000-000000000505';

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
  idempotencyKey: 'catalog:0050-attempt',
  ...overrides
});

function setup(options: { assert?: 'ok' | 'denied' | 'disabled'; linkFails?: boolean } = {}) {
  const order: string[] = [];
  const anyone = new Map<string, Array<{ id: string; role: string }>>([
    ['drive-video', []],
    ['drive-sheet', []]
  ]);
  const drive = {
    listAnyonePermissions: vi.fn(async (fileId: string) => anyone.get(fileId) ?? []),
    createAnyoneReaderPermission: vi.fn(async (fileId: string) => {
      anyone.set(fileId, [{ id: 'new', role: 'reader' }]);
      return { id: 'new', role: 'reader' as const };
    }),
    createConvertedFile: vi.fn(async (input: { name: string }) => {
      order.push('create-file');
      return metadata({
        id: 'drive-sheet',
        name: input.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/drive-sheet/edit',
        size: 4096
      });
    }),
    updateFileMetadata: vi.fn(async () => metadata())
  };
  const deps: ProductCatalogDeps = {
    loadVideo: vi.fn(async () => ({
      id: VIDEO,
      name: 'clip.mp4',
      category: 'video',
      driveFileId: 'drive-video',
      resourceKey: null,
      parentFolderId: 'folder',
      credentialId: 'cred'
    })),
    resolveRestitchedVideo: vi.fn(async () => {
      throw new Error('unused');
    }),
    readSettings: vi.fn(async () => ({
      title: 'Polo',
      description: 'Knit',
      imageLink: 'https://img.example.test/a.png',
      priceMin: 10,
      priceMax: 10
    })),
    drawTexts: vi.fn(async () => []),
    drawImages: vi.fn(async () => []),
    readLiveCatalogs: vi.fn(async () => []),
    nextVariant: vi.fn(async () => 1),
    driveFor: vi.fn(async () => drive as unknown as CatalogDrive),
    proveVideo: vi.fn(async () => metadata()),
    destination: vi.fn(async () => {
      order.push('destination');
      return {
        materialId: null,
        live: metadata({ id: 'folder', mimeType: 'application/vnd.google-apps.folder' })
      };
    }),
    planName: vi.fn(async ({ name }: { name: string }) => ({ name, reservationKey: name })),
    startOperation: vi.fn(async () => ({
      operationId: 'op',
      state: 'pending' as const,
      reused: false
    })),
    bindIntent: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    failOperation: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ materialId: NEW_SHEET })),
    link: vi.fn(async () => {
      order.push('link');
      if (options.linkFails) throw new TeamFunctionError('INVALID_RESPONSE');
      return { linked: true as const, retired: [] };
    }),
    log: vi.fn(),
    assertVideoR2Option: vi.fn(async () => {
      order.push('assert-r2');
      if (options.assert === 'denied') throw new TeamFunctionError('PERMISSION_DENIED');
      if (options.assert === 'disabled') throw new TeamFunctionError('VIDEO_R2_POLICY_PENDING');
    }),
    applyVideoR2Option: vi.fn(async () => {
      order.push('apply-r2');
    })
  } as unknown as ProductCatalogDeps;
  return { deps, order };
}

describe('catalog video R2 option at creation', () => {
  it('parses the option as an optional boolean and leaves the old request untouched', () => {
    expect(parseCreateProductCatalogRequest(body())).not.toHaveProperty('copyVideoToR2');
    expect(parseCreateProductCatalogRequest(body({ copyVideoToR2: false }))).not.toHaveProperty(
      'copyVideoToR2'
    );
    expect(parseCreateProductCatalogRequest(body({ copyVideoToR2: true })).copyVideoToR2).toBe(
      true
    );
    expect(() => parseCreateProductCatalogRequest(body({ copyVideoToR2: 'yes' }))).toThrow(
      /INVALID_INPUT/u
    );
  });

  it('checks the option before any provider side effect and records it only after registration', async () => {
    const f = setup({ assert: 'ok' });
    const result = await createProductCatalog(f.deps, body({ copyVideoToR2: true }), ACTOR);
    expect(result.outcome).toBe('created');
    expect(f.order).toEqual(['assert-r2', 'destination', 'create-file', 'link', 'apply-r2']);
    expect(f.deps.applyVideoR2Option).toHaveBeenCalledWith({
      teamId: TEAM,
      actorId: ACTOR,
      catalogMaterialId: NEW_SHEET
    });
  });

  it('refuses the request without the catalog settings permission or with the feature unavailable, leaving nothing behind', async () => {
    const denied = setup({ assert: 'denied' });
    await expect(
      createProductCatalog(denied.deps, body({ copyVideoToR2: true }), ACTOR)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(denied.order).toEqual(['assert-r2']);
    expect(denied.deps.destination).not.toHaveBeenCalled();
    const pending = setup({ assert: 'disabled' });
    await expect(
      createProductCatalog(pending.deps, body({ copyVideoToR2: true }), ACTOR)
    ).rejects.toMatchObject({ code: 'VIDEO_R2_POLICY_PENDING' });
    expect(pending.deps.startOperation).not.toHaveBeenCalled();
  });

  it('never touches the option hooks for a request without it, and not after a failed link', async () => {
    const plain = setup();
    await createProductCatalog(plain.deps, body(), ACTOR);
    expect(plain.deps.assertVideoR2Option).not.toHaveBeenCalled();
    expect(plain.deps.applyVideoR2Option).not.toHaveBeenCalled();
    const failed = setup({ assert: 'ok', linkFails: true });
    await expect(
      createProductCatalog(failed.deps, body({ copyVideoToR2: true }), ACTOR)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(failed.deps.applyVideoR2Option).not.toHaveBeenCalled();
  });
});
