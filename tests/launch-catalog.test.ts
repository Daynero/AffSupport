import { describe, expect, it, vi } from 'vitest';
import {
  createDurableProductCatalog,
  type CatalogIntent,
  type CatalogIntentStore,
  type DurableCatalogDrive
} from '../supabase/functions/drive-ops/catalog-durable';
import type { ProductCatalogDeps } from '../supabase/functions/drive-ops/product-catalog';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
const TEAM = '76000000-0000-4000-8000-000000000001',
  VIDEO = '76000000-0000-4000-8000-000000000002',
  ACTOR = '76000000-0000-4000-8000-000000000003';
const body = {
  teamId: TEAM,
  videoMaterialId: VIDEO,
  sourceLink: 'https://example.invalid/?sub1=patrik',
  productCount: 2,
  replacesMaterialId: null,
  restitchOperationId: null,
  idempotencyKey: 'catalog-durable-test'
};
function metadata(): DriveFileMetadata {
  return {
    id: 'sheet-drive',
    name: 'v5_v1_catalog',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    parents: ['folder'],
    trashed: false,
    driveId: null,
    ownedByMe: true,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    size: 100,
    modifiedAt: null,
    version: '1',
    checksum: null,
    webViewLink: 'https://docs.google.com/spreadsheets/d/sheet',
    appProperties: { 'soty.catalog.intent': 'intent' },
    capabilities: {
      canDownload: true,
      canListChildren: true,
      canAddChildren: true,
      canRename: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canModifyContent: true,
      canShare: true,
      canTrash: true,
      canUntrash: true
    }
  };
}
function fixture(lostReply: boolean) {
  const state: CatalogIntent = {
    id: 'intent',
    variant: 1,
    state: 'reserved',
    fence: '1',
    attempt: 1,
    checkpoint: {},
    result: null,
    operationId: null
  };
  const store: CatalogIntentStore = {
    begin: vi.fn(async () => state),
    checkpoint: vi.fn(async (intent, _owner, status, patch, op, result) => {
      intent.state = status;
      intent.checkpoint = { ...intent.checkpoint, ...patch };
      if (op) intent.operationId = op;
      if (result) intent.result = result;
    }),
    permission: vi.fn(async () => undefined)
  };
  let file: DriveFileMetadata | null = null;
  const create = vi.fn(async (input: Parameters<DurableCatalogDrive['createConvertedFile']>[0]) => {
    file = { ...metadata(), appProperties: input.appProperties ?? {} };
    if (lostReply) {
      lostReply = false;
      throw new Error('lost reply');
    }
    return file;
  });
  const drive: DurableCatalogDrive = {
    listAnyonePermissions: vi.fn(async () => [{ id: 'anyone', role: 'reader' as const }]),
    createAnyoneReaderPermission: vi.fn(async () => ({ id: 'grant', role: 'reader' as const })),
    createConvertedFile: create,
    updateFileMetadata: vi.fn(async () => metadata()),
    getFile: vi.fn(async () => file ?? metadata()),
    findCatalogIntentFiles: vi.fn(async () => (file ? [file] : []))
  };
  const deps: ProductCatalogDeps = {
    loadVideo: vi.fn(async () => ({
      id: VIDEO,
      name: 'v5.mp4',
      category: 'video',
      driveFileId: 'video-drive',
      resourceKey: null,
      parentFolderId: 'folder',
      credentialId: 'credential'
    })),
    readSettings: vi.fn(async () => ({
      title: 'Test',
      description: 'Description',
      imageLink: 'https://example.invalid/image',
      priceMin: 10,
      priceMax: 20
    })),
    resolveRestitchedVideo: vi.fn(),
    drawTexts: vi.fn(async () => []),
    drawImages: vi.fn(async () => []),
    readLiveCatalogs: vi.fn(async () => []),
    nextVariant: vi.fn(async () => 9),
    driveFor: vi.fn(async () => drive),
    proveVideo: vi.fn(async () => ({ ...metadata(), id: 'video-drive', mimeType: 'video/mp4' })),
    destination: vi.fn(async () => ({
      materialId: null,
      live: { ...metadata(), id: 'folder', mimeType: 'application/vnd.google-apps.folder' }
    })),
    planName: vi.fn(async () => ({ name: 'v5_v1_catalog', reservationKey: 'reserved-name' })),
    startOperation: vi.fn(async () => ({
      operationId: 'child-operation',
      state: 'pending' as const,
      reused: false
    })),
    bindIntent: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    failOperation: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ materialId: 'catalog-material' })),
    link: vi.fn(async () => ({ linked: true as const, retired: [], variant: 1 })),
    log: vi.fn()
  };
  return { store, deps, drive, state, create };
}
describe('durable reuse of existing catalog generator', () => {
  it('keeps the bounded missing-settings reason so the form can offer the settings repair', async () => {
    const f = fixture(false);
    vi.mocked(f.deps.readSettings).mockResolvedValue({
      title: null,
      description: null,
      imageLink: null,
      priceMin: 9,
      priceMax: 30
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'WRONG_STATE', details: { reason: 'settings_missing' } });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('does not expose arbitrary details beside an allowed catalog refusal reason', async () => {
    const f = fixture(false);
    vi.mocked(f.deps.readSettings).mockRejectedValue(
      new TeamFunctionError('WRONG_STATE', {
        details: { reason: 'settings_missing', payload: 'SYNTHETIC_SECRET' }
      })
    );
    const error = await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      body,
      ACTOR
    ).then(
      () => {
        throw new Error('Expected a catalog refusal');
      },
      error => error as TeamFunctionError
    );
    expect(error.details).toEqual({ reason: 'settings_missing' });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC_SECRET');
  });

  it('reconciles a lost Drive create reply using a marker without creating a second sheet', async () => {
    const f = fixture(true);
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LAUNCH_INTERNAL_ERROR' });
    expect(f.state.checkpoint.createStarted).toBe(true);
    expect(f.state.state).toBe('interrupted');
    const rows = f.state.checkpoint.sheetRows;
    const result = await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      body,
      ACTOR
    );
    expect(result.catalog.variant).toBe(1);
    expect(result.catalog.sheetUrl).toBe('https://docs.google.com/spreadsheets/d/sheet');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.deps.nextVariant).not.toHaveBeenCalled();
    expect(f.drive.findCatalogIntentFiles).toHaveBeenCalledTimes(1);
    expect(f.state.checkpoint.sheetRows).toEqual(rows);
    expect(f.deps.drawTexts).toHaveBeenCalledTimes(1);
    expect(f.deps.drawImages).toHaveBeenCalledTimes(1);
  });
  it('replays a registered result before any provider operation', async () => {
    const f = fixture(false);
    const first = await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      body,
      ACTOR
    );
    const calls = f.drive.listAnyonePermissions;
    vi.mocked(calls).mockClear();
    const second = await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      body,
      ACTOR
    );
    expect(second).toEqual(first);
    expect(calls).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('does not interpret an empty marker lookup as proof that another create is safe', async () => {
    const f = fixture(false);
    f.state.state = 'interrupted';
    f.state.checkpoint.createStarted = true;
    f.state.checkpoint.parentId = 'folder';
    f.state.checkpoint.credentialId = 'credential';
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LAUNCH_RESULT_UNCERTAIN' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('reuses the same owned sheet after a sharing refusal instead of creating another variation', async () => {
    const f = fixture(false);
    let sheetShared = false;
    vi.mocked(f.drive.listAnyonePermissions).mockImplementation(async fileId =>
      fileId === 'sheet-drive'
        ? sheetShared
          ? [{ id: 'grant', role: 'reader' }]
          : []
        : [{ id: 'existing', role: 'reader' }]
    );
    vi.mocked(f.drive.createAnyoneReaderPermission).mockRejectedValueOnce(
      new TeamFunctionError('RATE_LIMITED', { retryable: true })
    );
    vi.mocked(f.drive.createAnyoneReaderPermission).mockImplementationOnce(async () => {
      sheetShared = true;
      return { id: 'grant', role: 'reader' };
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(f.state.checkpoint.providerFileId).toBe('sheet-drive');
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).resolves.toMatchObject({ catalog: { variant: 1, materialId: 'catalog-material' } });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.deps.nextVariant).not.toHaveBeenCalled();
    expect(f.store.permission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'intent' }),
      expect.any(String),
      'sheet-drive',
      'credential',
      'grant',
      'created'
    );
  });
  it('keeps the provider file after an interrupted finalize and recovers the reserved catalog', async () => {
    const f = fixture(false);
    vi.mocked(f.deps.finalize).mockRejectedValueOnce(
      new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true })
    );
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'DRIVE_UNAVAILABLE' });
    expect(f.state.checkpoint.providerFileId).toBe('sheet-drive');
    expect(f.state.state).toBe('interrupted');
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).resolves.toMatchObject({ catalog: { variant: 1, materialId: 'catalog-material' } });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.deps.finalize).toHaveBeenCalledTimes(2);
  });
  it('does not link a finalized catalog after the intent fence is lost', async () => {
    const f = fixture(false);
    const checkpoint = f.store.checkpoint;
    let revoked = false;
    f.store.checkpoint = vi.fn(async (...args: Parameters<CatalogIntentStore['checkpoint']>) => {
      const [, , state, patch] = args;
      if (revoked && state === 'finalized' && Object.keys(patch).length === 0)
        throw new TeamFunctionError('LEASE_MISMATCH');
      await checkpoint(...args);
      if (state === 'finalized') revoked = true;
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    expect(f.deps.finalize).toHaveBeenCalledTimes(1);
    expect(f.deps.link).not.toHaveBeenCalled();
    expect(f.state.checkpoint.providerFileId).toBe('sheet-drive');
  });
  it('records a successful link before declaring the durable catalog registered', async () => {
    const f = fixture(false);
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    const checkpoints = vi.mocked(f.store.checkpoint).mock.calls;
    const linkedAt = checkpoints.findIndex(([, , , patch]) => patch.linkCompleted === true);
    const registeredAt = checkpoints.findIndex(([, , state]) => state === 'registered');
    expect(linkedAt).toBeGreaterThanOrEqual(0);
    expect(registeredAt).toBeGreaterThan(linkedAt);
    expect(f.state.checkpoint.linkCompleted).toBe(true);
  });
  it('does not report link success when its post-link fence has expired', async () => {
    const f = fixture(false);
    const checkpoint = f.store.checkpoint;
    f.store.checkpoint = vi.fn(async (...args: Parameters<CatalogIntentStore['checkpoint']>) => {
      if (args[3].linkCompleted === true) throw new TeamFunctionError('LEASE_MISMATCH');
      await checkpoint(...args);
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    expect(f.deps.link).toHaveBeenCalledOnce();
    expect(f.state.checkpoint.linkCompleted).toBeUndefined();
    expect(f.state.state).toBe('interrupted');
    expect(
      vi.mocked(f.store.checkpoint).mock.calls.some(([, , state]) => state === 'registered')
    ).toBe(false);
  });
  it('does not create a sheet after the intent fence is lost before the provider call', async () => {
    const f = fixture(false);
    const checkpoint = f.store.checkpoint;
    let revoked = false;
    f.store.checkpoint = vi.fn(async (...args: Parameters<CatalogIntentStore['checkpoint']>) => {
      if (revoked && Object.keys(args[3]).length === 0)
        throw new TeamFunctionError('LEASE_MISMATCH');
      await checkpoint(...args);
    });
    vi.mocked(f.deps.markRunning).mockImplementation(async () => {
      revoked = true;
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.deps.finalize).not.toHaveBeenCalled();
  });
  it('does not finalize a created sheet after the intent fence is lost', async () => {
    const f = fixture(false);
    const checkpoint = f.store.checkpoint;
    let revoked = false;
    f.store.checkpoint = vi.fn(async (...args: Parameters<CatalogIntentStore['checkpoint']>) => {
      if (revoked && Object.keys(args[3]).length === 0)
        throw new TeamFunctionError('LEASE_MISMATCH');
      await checkpoint(...args);
    });
    vi.mocked(f.deps.bindIntent).mockImplementation(async () => {
      revoked = true;
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.state.checkpoint.providerFileId).toBe('sheet-drive');
    expect(f.deps.finalize).not.toHaveBeenCalled();
    expect(f.deps.link).not.toHaveBeenCalled();
  });
});

it('does not draw durable resource pools before settings validation', async () => {
  const f = fixture(false);
  f.store.resources = vi.fn(async () => ({}));
  vi.mocked(f.deps.readSettings).mockResolvedValue(null);
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  expect(f.store.resources).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
it('refuses marker-only recovery when ownership cannot be proven', async () => {
  const f = fixture(true);
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'LAUNCH_INTERNAL_ERROR' });
  vi.mocked(f.drive.findCatalogIntentFiles).mockResolvedValue([
    { ...metadata(), ownedByMe: false }
  ]);
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'LAUNCH_RESULT_UNCERTAIN' });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.deps.finalize).not.toHaveBeenCalled();
});

it('reconciles the same binary after sharing changes its provider version', async () => {
  const f = fixture(true);
  const proof = vi.mocked(f.deps.proveVideo);
  proof.mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    version: '1',
    checksum: 'a'.repeat(32)
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'LAUNCH_INTERNAL_ERROR' });
  proof.mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    version: '2',
    checksum: 'a'.repeat(32),
    modifiedAt: '2026-10-13T10:00:00Z'
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).resolves.toMatchObject({ catalog: { materialId: 'catalog-material' } });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('rejects changed binary contents before reconciling an unregistered catalog', async () => {
  const f = fixture(true);
  const proof = vi.mocked(f.deps.proveVideo);
  proof.mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    version: '1',
    checksum: 'a'.repeat(32)
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'LAUNCH_INTERNAL_ERROR' });
  proof.mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    version: '2',
    checksum: 'b'.repeat(32)
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.create).toHaveBeenCalledTimes(1);
});

it('retries a definitive create refusal using the same reserved variation and recipe', async () => {
  const f = fixture(false);
  f.create.mockRejectedValueOnce(new TeamFunctionError('RATE_LIMITED', { retryable: true }));
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(f.state.checkpoint.createStarted).toBe(false);
  const rows = structuredClone(f.state.checkpoint.sheetRows);
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).resolves.toMatchObject({ catalog: { variant: 1 } });
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.state.variant).toBe(1);
  expect(f.state.checkpoint.sheetRows).toEqual(rows);
  expect(f.deps.nextVariant).not.toHaveBeenCalled();
});
