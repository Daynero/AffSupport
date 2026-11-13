import {
  PRODUCT_CATALOG_TEMPLATE,
  parseCatalogRowRecipe
} from '../supabase/functions/_shared/product-catalog';
import { describe, expect, it, vi } from 'vitest';
import {
  createDurableProductCatalog,
  resumeOrReadInitialCatalog,
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

describe('R2 durable version and publication authority', () => {
  it('refuses a fresh old-client request before accepting an intent or touching Drive', async () => {
    const f = fixture(false);
    f.store.imageRequestVersion = vi.fn(async () => null);
    f.deps.assertImageContract = vi.fn(async () => {
      throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'CATALOG_IMAGE_UPGRADE_REQUIRED' });
    expect(f.store.begin).not.toHaveBeenCalled();
    expect(f.deps.loadVideo).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('normalizes only a server-accepted legacy request and preserves its original draw', async () => {
    const f = fixture(false);
    f.store.imageRequestVersion = vi.fn(async () => 1 as const);
    f.deps.assertImageContract = vi.fn(async () => {
      throw new TeamFunctionError('CATALOG_IMAGE_UPGRADE_REQUIRED');
    });
    await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      { ...body, catalogImageContractVersion: 2 },
      ACTOR
    );
    expect(f.store.begin).toHaveBeenCalledWith(
      { ...body, randomLinkVariation: true },
      expect.any(String)
    );
    expect(f.deps.assertImageContract).not.toHaveBeenCalled();
    expect(f.deps.drawImages).toHaveBeenCalledWith(
      TEAM,
      2,
      expect.objectContaining({ contractVersion: undefined, attemptId: 'intent' })
    );
  });
  it('normalizes a current client replay to the accepted v2 payload before hashing', async () => {
    const f = fixture(false);
    await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      { ...body, catalogImageContractVersion: 2 },
      ACTOR
    );
    vi.mocked(f.store.begin).mockClear();
    f.store.imageRequestVersion = vi.fn(async () => 2 as const);
    f.deps.assertImageContract = vi.fn(async () => {
      throw new TeamFunctionError('GLOBAL_IMAGE_CLIENT_UPGRADE_REQUIRED');
    });
    await createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      { ...body, catalogImageContractVersion: 3 },
      ACTOR
    );
    expect(f.store.begin).toHaveBeenCalledWith(
      { ...body, randomLinkVariation: true, catalogImageContractVersion: 2 },
      expect.any(String)
    );
    expect(f.deps.assertImageContract).not.toHaveBeenCalled();
  });
  it('keeps an accepted v2 request from being retried through an old payload', async () => {
    const f = fixture(false);
    f.store.imageRequestVersion = vi.fn(async () => 2 as const);
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'CATALOG_IMAGE_UPGRADE_REQUIRED' });
    expect(f.store.begin).not.toHaveBeenCalled();
  });
  it('rechecks frozen image authority before creating a sheet and keeps revoked uses unknown', async () => {
    const f = fixture(false);
    f.deps.validateImageUses = vi.fn(async () => {
      throw new TeamFunctionError('IMAGE_PUBLICATION_REVOKED');
    });
    f.deps.finalizeImageUses = vi.fn(async () => undefined);
    await expect(
      createDurableProductCatalog(
        f.deps,
        f.store,
        async () => f.drive,
        { ...body, catalogImageContractVersion: 2 },
        ACTOR
      )
    ).rejects.toMatchObject({ code: 'IMAGE_PUBLICATION_REVOKED' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.deps.finalizeImageUses).toHaveBeenCalledWith(TEAM, 'intent', false);
  });
  it('does not report registered success when publication revocation races external delivery', async () => {
    const f = fixture(false);
    f.deps.finalizeImageUses = vi.fn(async (_team, _attempt, delivered) => {
      if (delivered) throw new TeamFunctionError('IMAGE_PUBLICATION_REVOKED');
    });
    await expect(
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
    ).rejects.toMatchObject({ code: 'IMAGE_PUBLICATION_REVOKED' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.state.state).toBe('interrupted');
    expect(f.state.checkpoint.providerFileId).toBe('sheet-drive');
  });
});
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

// This exercises the real durable generator with recording provider/store seams.
// It is a concurrency regression, not a database, browser or server capacity benchmark.
describe.each([3, 10])('%i concurrent catalog attempts', count => {
  it('isolates dependency refusal and uncertain delivery, then replays without duplicate Sheets', async () => {
    const fixtures = Array.from({ length: count }, (_, index) => fixture(index === 1));
    const blocked = fixtures[0];
    vi.mocked(blocked.deps.proveVideo).mockRejectedValueOnce(
      new TeamFunctionError('NEEDS_REAUTH', { retryable: true })
    );
    // Yield at a real dependency boundary so the attempts overlap instead of
    // completing each recording fake synchronously before the next one starts.
    let release!: () => void;
    let arrivals = 0;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    for (const f of fixtures) {
      const readSettings = f.deps.readSettings;
      f.deps.readSettings = vi.fn(async team => {
        arrivals += 1;
        if (arrivals === count) release();
        await gate;
        return readSettings(team);
      });
    }
    const run = (index: number) => {
      const f = fixtures[index];
      return createDurableProductCatalog(
        f.deps,
        f.store,
        async () => f.drive,
        { ...body, idempotencyKey: `mixed-workload-${index}` },
        ACTOR
      );
    };
    const first = await Promise.allSettled(fixtures.map((_, index) => run(index)));
    expect(first[0]).toMatchObject({ status: 'rejected', reason: { code: 'NEEDS_REAUTH' } });
    expect(first[1]).toMatchObject({ status: 'rejected' });
    expect(first.slice(2).every(result => result.status === 'fulfilled')).toBe(true);
    expect(blocked.create).not.toHaveBeenCalled();
    expect(blocked.deps.drawTexts).not.toHaveBeenCalled();
    expect(blocked.deps.drawImages).not.toHaveBeenCalled();
    expect(fixtures[1].state.checkpoint.createStarted).toBe(true);

    const recovered = await Promise.all(fixtures.map((_, index) => run(index)));
    expect(recovered).toHaveLength(count);
    for (const f of fixtures) {
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.state.state).toBe('registered');
      expect(f.deps.finalize).toHaveBeenCalledTimes(1);
    }
    await Promise.all(fixtures.map((_, index) => run(index)));
    for (const f of fixtures) {
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.deps.finalize).toHaveBeenCalledTimes(1);
    }
  });
});

describe('automatic content through durable creation', () => {
  it.each(['planning', 'create_reply'] as const)(
    'creates without saved settings and preserves exact choices after %s interruption',
    async failure => {
      const f = fixture(failure === 'create_reply');
      f.state.checkpoint.contentPolicyVersion = 1;
      vi.mocked(f.deps.readSettings).mockResolvedValue(null);
      vi.mocked(f.deps.drawImages).mockResolvedValue([
        { driveFileId: 'dress-image', resourceKey: null, name: 'wrap-dress_coral_001.png' },
        { driveFileId: 'tshirt-image', resourceKey: null, name: 'tshirt_black_001.png' }
      ]);
      if (failure === 'planning')
        vi.mocked(f.deps.planName).mockRejectedValueOnce(
          new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true })
        );
      await expect(
        createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
      ).rejects.toBeDefined();
      const rows = parseCatalogRowRecipe(f.state.checkpoint.rowRecipe);
      expect(rows).toHaveLength(2);
      expect(rows![0]!.title).toMatch(/Coral Wrap Dress/u);
      expect(rows![0]!.price).toBeGreaterThanOrEqual(50);
      expect(rows![0]!.price).toBeLessThanOrEqual(95);
      expect(rows![1]!.title).toMatch(/Black T-Shirt/u);
      expect(rows![1]!.price).toBeGreaterThanOrEqual(12);
      expect(rows![1]!.price).toBeLessThanOrEqual(24);
      expect(f.state.checkpoint).toMatchObject({
        content_policy_version: 1,
        planned_row_count: 2,
        automatic_row_count: 2,
        retained_row_count: 0
      });
      const original = structuredClone(rows);
      vi.mocked(f.deps.drawImages).mockRejectedValue(
        new Error('A retry must not draw images again')
      );
      vi.mocked(f.deps.readSettings).mockRejectedValue(
        new Error('Frozen settings must be restored')
      );
      const result = await createDurableProductCatalog(
        f.deps,
        f.store,
        async () => f.drive,
        body,
        ACTOR
      );
      expect(result).toMatchObject({
        outcome: 'created',
        catalog: { materialId: 'catalog-material' }
      });
      expect(f.state.checkpoint.rowRecipe).toEqual(original);
      expect(f.state.state).toBe('registered');
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.deps.drawImages).toHaveBeenCalledTimes(1);
      expect(f.deps.drawTexts).not.toHaveBeenCalled();
      expect(f.deps.readSettings).toHaveBeenCalledTimes(1);
    }
  );
});

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
    if (result.outcome === 'preparing_video')
      throw new Error('Legacy catalog unexpectedly entered video preparation');
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

it('does not create another Sheet when the selected parent becomes stale during lost-reply recovery', async () => {
  const f = fixture(true);
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'LAUNCH_INTERNAL_ERROR' });
  vi.mocked(f.deps.proveVideo).mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    parents: ['moved-folder']
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.deps.finalize).not.toHaveBeenCalled();
  expect(f.state.state).toBe('interrupted');
  expect(f.state.checkpoint.createStarted).toBe(true);
});

it('reuses the accepted intent after the selected parent index catches up', async () => {
  const f = fixture(false);
  vi.mocked(f.deps.proveVideo).mockResolvedValue({
    ...metadata(),
    id: 'video-drive',
    mimeType: 'video/mp4',
    parents: ['moved-folder']
  });
  const run = () => createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
  await expect(run()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(f.create).not.toHaveBeenCalled();
  const original = await f.deps.loadVideo({
    teamId: TEAM,
    videoId: VIDEO,
    actorId: ACTOR,
    permission: 'view'
  });
  vi.mocked(f.deps.loadVideo).mockResolvedValue({ ...original, parentFolderId: 'moved-folder' });
  vi.mocked(f.deps.destination).mockResolvedValue({
    materialId: null,
    live: { ...metadata(), id: 'moved-folder', mimeType: 'application/vnd.google-apps.folder' }
  });
  f.create.mockImplementation(async input => ({
    ...metadata(),
    parents: [input.parentId],
    appProperties: input.appProperties ?? {}
  }));
  await expect(run()).resolves.toMatchObject({ outcome: 'created' });
  await expect(run()).resolves.toMatchObject({ outcome: 'created' });
  expect(f.state.id).toBe('intent');
  expect(f.state.attempt).toBe(1);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.deps.finalize).toHaveBeenCalledTimes(1);
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

it('finishes a resumed interrupted intent in one pass without releasing its own lease', async () => {
  // 1.4.3 QA round 2 (N4): service_checkpoint_catalog_intent releases the lease
  // whenever the state is 'interrupted'. A resumed intent re-checkpointed its
  // own 'interrupted' state for the settings and then the source proof, so the
  // next checkpoint failed LEASE_MISMATCH twice (409 on the dialog's resume)
  // and only a third pass created the catalog.
  const f = fixture(false);
  f.state.state = 'interrupted';
  let leaseLive = false;
  vi.mocked(f.store.begin).mockImplementation(async () => {
    leaseLive = true;
    return f.state;
  });
  const checkpoint = f.store.checkpoint;
  f.store.checkpoint = vi.fn(async (...args: Parameters<CatalogIntentStore['checkpoint']>) => {
    if (!leaseLive) throw new TeamFunctionError('LEASE_MISMATCH', { retryable: true });
    if (args[2] === 'interrupted' || args[2] === 'cleanup_pending') leaseLive = false;
    await checkpoint(...args);
  });
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR)
  ).resolves.toMatchObject({ catalog: { materialId: 'catalog-material' } });
  expect(f.state.state).toBe('registered');
  expect(f.create).toHaveBeenCalledTimes(1);
  const states = vi.mocked(f.store.checkpoint).mock.calls.map(call => call[2]);
  expect(states).not.toContain('interrupted');
});

describe('dialog resume while another pass holds the creation lease', () => {
  const progress = { outcome: 'preparing_video', state: 'preparing' };
  it('answers with the current progress instead of GROUP_RECONCILING', async () => {
    await expect(
      resumeOrReadInitialCatalog(
        Promise.reject(new TeamFunctionError('GROUP_RECONCILING', { retryable: true })),
        async () => progress
      )
    ).resolves.toBe(progress);
  });
  it('keeps every other refusal, and the 409 when no progress can be read', async () => {
    const read = vi.fn(async () => progress);
    await expect(
      resumeOrReadInitialCatalog(Promise.reject(new TeamFunctionError('SOURCE_CHANGED')), read)
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(read).not.toHaveBeenCalled();
    await expect(
      resumeOrReadInitialCatalog(
        Promise.reject(new TeamFunctionError('GROUP_RECONCILING', { retryable: true })),
        async () => null
      )
    ).rejects.toMatchObject({ code: 'GROUP_RECONCILING' });
    await expect(
      resumeOrReadInitialCatalog(
        Promise.reject(new TeamFunctionError('GROUP_RECONCILING', { retryable: true })),
        async () => {
          throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
        }
      )
    ).rejects.toMatchObject({ code: 'GROUP_RECONCILING' });
  });
});

it('persists measured successful boundaries in the final attempt receipt', async () => {
  const f = fixture(false);
  await createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
  expect(f.state.checkpoint.performance).toMatchObject({
    attempt: 1,
    steps: {
      sheet_upload: { calls: 1 },
      xlsx_build: { calls: 1 },
      catalog_finalize: { calls: 1 },
      catalog_link: { calls: 1 }
    }
  });
});

describe('local beta native Sheets recovery', () => {
  function nativeFixture(lostCreateReply = false) {
    const f = fixture(lostCreateReply);
    f.deps.nativeSpreadsheet = true;
    f.drive.createNativeSpreadsheet = vi.fn(input =>
      f.create({
        ...input,
        sourceMimeType: 'unused-native',
        targetMimeType: 'application/vnd.google-apps.spreadsheet',
        bytes: new Uint8Array()
      })
    );
    f.drive.getNativeSpreadsheetSheets = vi.fn(async () => [
      { sheetId: 173, title: 'Sheet1', rowCount: 1000, columnCount: 26 }
    ]);
    f.drive.writeNativeSpreadsheetRows = vi.fn(async () => undefined);
    return f;
  }
  it('recovers an unknown native file creation by its marker without making a second file', async () => {
    const f = nativeFixture(true);
    const run = () =>
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    await expect(run()).rejects.toBeDefined();
    expect(f.state.checkpoint.sheetEngine).toBe('native');
    expect((await f.drive.getFile('sheet')).appProperties).toEqual({
      'soty.catalog.nativeIntent': 'intent'
    });
    expect((await f.drive.getFile('sheet')).appProperties['soty.catalog.intent']).toBeUndefined();
    f.deps.nativeSpreadsheet = false; // Background recovery must retain the accepted writer.
    await expect(run()).resolves.toMatchObject({ outcome: 'created' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.drive.createNativeSpreadsheet).toHaveBeenCalledTimes(1);
    expect(f.drive.writeNativeSpreadsheetRows).toHaveBeenCalledTimes(1);
    expect(f.state.checkpoint.nativeRowsWritten).toMatchObject({ sheetId: 173 });
    await run();
    expect(f.drive.writeNativeSpreadsheetRows).toHaveBeenCalledTimes(1);
  });
  it('retries an unknown cell write with the exact frozen range and bound sheet ID', async () => {
    const f = nativeFixture();
    vi.mocked(f.drive.writeNativeSpreadsheetRows!).mockRejectedValueOnce(
      new Error('lost cell write reply')
    );
    const run = () =>
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    await expect(run()).rejects.toBeDefined();
    expect(f.state.checkpoint.nativeRowsWritten).toBeUndefined();
    const first = vi.mocked(f.drive.writeNativeSpreadsheetRows!).mock.calls[0]![0];
    await expect(run()).resolves.toMatchObject({ outcome: 'created' });
    const second = vi.mocked(f.drive.writeNativeSpreadsheetRows!).mock.calls[1]![0];
    expect(second.rows).toEqual(first.rows);
    expect(second.sheet.sheetId).toBe(first.sheet.sheetId);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an acknowledged write when later registration failed', async () => {
    const f = nativeFixture();
    vi.mocked(f.deps.finalize).mockRejectedValueOnce(new TeamFunctionError('DRIVE_UNAVAILABLE'));
    const run = () =>
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    await expect(run()).rejects.toBeDefined();
    expect(f.state.checkpoint.nativeRowsWritten).toBeDefined();
    await expect(run()).resolves.toMatchObject({ outcome: 'created' });
    expect(f.drive.writeNativeSpreadsheetRows).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('keeps already-started legacy attempts on XLSX even when the experiment is enabled', async () => {
    const f = nativeFixture();
    f.state.state = 'interrupted';
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    expect(f.drive.createNativeSpreadsheet).not.toHaveBeenCalled();
    expect(f.drive.createConvertedFile).toHaveBeenCalledTimes(1);
  });
  it('refuses to redirect a retry to a replacement sheet when the bound sheet was deleted', async () => {
    const f = nativeFixture();
    vi.mocked(f.drive.writeNativeSpreadsheetRows!).mockRejectedValueOnce(new Error('lost reply'));
    const run = () =>
      createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
    await expect(run()).rejects.toBeDefined();
    vi.mocked(f.drive.getNativeSpreadsheetSheets!).mockResolvedValueOnce([
      { sheetId: 999, title: 'Other', rowCount: 1000, columnCount: 26 }
    ]);
    await expect(run()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.drive.writeNativeSpreadsheetRows).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});

describe('initial durable N video preparation', () => {
  it('persists stable children before immediate pending ACK without provider catalog writes', async () => {
    const f = fixture(false);
    const serverNow = vi.fn(async () => Date.parse('2030-01-01T00:00:00Z'));
    const prepare = vi.fn(async () => ({ state: 'preparing' as const, registeredCount: 1 }));
    f.deps.initialVideoAuthority = { serverNow, prepare, registerCreated: vi.fn() };
    const request = {
      ...body,
      catalogVideoProtocolVersion: 1,
      restitchEnabled: true,
      videoVariationCount: 2,
      videoPublication: { mode: 'immediate' }
    };
    expect(
      await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
    ).toMatchObject({ outcome: 'preparing_video', requestedCount: 2, registeredCount: 1 });
    const original = structuredClone(f.state.checkpoint.initialVideoPlan);
    expect(f.state.state).toBe('interrupted');
    serverNow.mockResolvedValue(Date.parse('2040-01-01T00:00:00Z'));
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR);
    expect(serverNow).toHaveBeenCalledOnce();
    expect(f.state.checkpoint.initialVideoPlan).toEqual(original);
    expect(prepare).toHaveBeenLastCalledWith({ intentId: f.state.id, plan: original });
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe('initial provider proof accounting', () => {
  it('retains image uses when the catalog exists but final readback is unknown', async () => {
    const f = fixture(false),
      finalizeImageUses = vi.fn(async () => {});
    f.deps.finalizeImageUses = finalizeImageUses;
    f.deps.initialVideoAuthority = {
      serverNow: vi.fn(async () => Date.parse('2030-01-01T00:00:00Z')),
      prepare: vi.fn(),
      registerCreated: vi.fn(async () => {
        throw new TeamFunctionError('PROCESS_RESULT_UNCERTAIN');
      })
    };
    await expect(
      createDurableProductCatalog(
        f.deps,
        f.store,
        async () => f.drive,
        {
          ...body,
          catalogVideoProtocolVersion: 1,
          restitchEnabled: false,
          videoVariationCount: 1,
          videoPublication: { mode: 'immediate' }
        },
        ACTOR
      )
    ).rejects.toBeDefined();
    expect(typeof f.state.checkpoint.materialId).toBe('string');
    expect(f.create).toHaveBeenCalledOnce();
    expect(finalizeImageUses).toHaveBeenCalledWith(TEAM, f.state.id, true);
    expect(finalizeImageUses).not.toHaveBeenCalledWith(TEAM, f.state.id, false);
  });
});

it('journals a definite initial admission failure before a video set exists', async () => {
  const f = fixture(false);
  f.deps.initialVideoAuthority = {
    serverNow: vi.fn(async () => Date.parse('2030-01-01T00:00:00Z')),
    prepare: vi.fn(async () => {
      throw new TeamFunctionError('RESTITCH_NO_SCREENS');
    }),
    registerCreated: vi.fn()
  };
  await expect(
    createDurableProductCatalog(
      f.deps,
      f.store,
      async () => f.drive,
      {
        ...body,
        catalogVideoProtocolVersion: 1,
        restitchEnabled: true,
        videoVariationCount: 2,
        videoPublication: { mode: 'immediate' }
      },
      ACTOR
    )
  ).rejects.toMatchObject({ code: 'RESTITCH_NO_SCREENS' });
  expect(f.state.state).toBe('interrupted');
  expect(f.state.checkpoint).toMatchObject({
    safeErrorCode: 'RESTITCH_NO_SCREENS',
    videoPreparationPending: false
  });
  expect(f.create).not.toHaveBeenCalled();
});

it('re-runs the open initial publication verification for an already registered catalog', async () => {
  // The check stayed open after the create-time verification failed; the
  // recovery pass lists the registered intent again until it verifies.
  const f = fixture(false);
  const plan = { recipeRowIds: ['r1', 'r2'], preferences: { catalogVideoProtocolVersion: 1 } };
  f.state.state = 'registered';
  f.state.checkpoint = { materialId: 'catalog-material', initialVideoPlan: plan };
  f.state.result = {
    outcome: 'created',
    videoShared: true,
    catalog: {
      materialId: 'catalog-material',
      name: 'TR_v1_catalog',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/x',
      sourceLink: body.sourceLink,
      productCount: 2,
      createdAt: null
    }
  };
  const registerCreated = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new TeamFunctionError('PERMISSION_DENIED'));
  f.deps.initialVideoAuthority = {
    serverNow: vi.fn(async () => Date.now()),
    prepare: vi.fn(),
    registerCreated
  };
  const request = {
    ...body,
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' }
  };
  // A failed verification leaves the registered result untouched.
  expect(
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
  ).toMatchObject({ outcome: 'created', catalog: { materialId: 'catalog-material' } });
  expect(registerCreated).toHaveBeenCalledWith({
    intentId: 'intent',
    plan,
    catalogMaterialId: 'catalog-material'
  });
  expect(f.state.state).toBe('registered');
  expect(f.create).not.toHaveBeenCalled();
  // The next pass verifies.
  await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR);
  expect(registerCreated).toHaveBeenCalledTimes(2);
  // A legacy request (no video protocol) never touches the authority.
  await createDurableProductCatalog(f.deps, f.store, async () => f.drive, body, ACTOR);
  expect(registerCreated).toHaveBeenCalledTimes(2);
});

it('creates and verifies the scheduled blank catalog while admitted N work is still preparing', async () => {
  const f = fixture(false),
    serverNow = vi.fn(async () => Date.parse('2030-01-01T00:00:00Z'));
  const registerCreated = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new TeamFunctionError('PROCESS_RESULT_UNCERTAIN'));
  f.deps.initialVideoAuthority = {
    serverNow,
    prepare: vi.fn(async () => ({ state: 'preparing' as const, registeredCount: 1 })),
    registerCreated
  };
  f.store.operation = async () =>
    typeof f.state.checkpoint.materialId === 'string'
      ? { state: 'succeeded', materialId: 'catalog-material' }
      : null;
  const request = {
    ...body,
    catalogVideoProtocolVersion: 1,
    restitchEnabled: true,
    videoVariationCount: 2,
    videoPublication: {
      mode: 'scheduled',
      localDateTime: '2030-01-02T10:00',
      timeZone: 'UTC',
      resolvedOffset: '+00:00',
      dueAt: '2030-01-02T10:00:00.000Z'
    }
  };
  await expect(
    createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
  ).rejects.toBeDefined();
  const original = structuredClone(f.state.checkpoint.initialVideoPlan),
    column = PRODUCT_CATALOG_TEMPLATE.findIndex(c => c.source.kind === 'videoLink');
  expect(
    (f.state.checkpoint.sheetRows as Array<Array<{ v: unknown }>>)
      .slice(2)
      .every(row => row[column]!.v === '')
  ).toBe(true);
  expect(f.create).toHaveBeenCalledOnce();
  serverNow.mockResolvedValue(Date.parse('2040-01-01T00:00:00Z'));
  expect(
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
  ).toMatchObject({
    outcome: 'created',
    videoGeneration: {
      requestedCount: 2,
      registeredCount: 1,
      state: 'preparing',
      catalogVideoCells: 'deferred_blank',
      providerCas: 'unsupported'
    }
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(serverNow).toHaveBeenCalledOnce();
  expect(f.state.checkpoint.initialVideoPlan).toEqual(original);
});

it('claims a paced re-verification before any work and records the failure code', async () => {
  // 1.4.2 paced inside the begin step, so a begin that raised rolled the pacing
  // back and the intent was retried every pass. The claim now commits first.
  const f = fixture(false);
  const plan = { recipeRowIds: ['r1', 'r2'], preferences: { catalogVideoProtocolVersion: 1 } };
  f.state.state = 'registered';
  f.state.checkpoint = { materialId: 'catalog-material', initialVideoPlan: plan };
  f.state.result = {
    outcome: 'created',
    videoShared: true,
    catalog: {
      materialId: 'catalog-material',
      name: 'TR_v1_catalog',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/x',
      sourceLink: body.sourceLink,
      productCount: 2,
      createdAt: null
    }
  };
  const claims: Array<'go' | 'paced' | 'exhausted' | 'done'> = ['paced', 'go', 'exhausted'];
  const claimReverify = vi.fn(async () => claims.shift()!);
  const noteReverify = vi.fn(async () => {});
  const registerCreated = vi.fn(async () => {
    throw new TeamFunctionError('WRONG_STATE');
  });
  f.deps.initialVideoAuthority = {
    serverNow: vi.fn(async () => Date.now()),
    prepare: vi.fn(),
    registerCreated,
    claimReverify,
    noteReverify
  };
  const request = {
    ...body,
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: { mode: 'immediate' }
  };
  // Paced: nothing runs.
  await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR);
  expect(registerCreated).not.toHaveBeenCalled();
  // Claimed: it runs, fails, and the code is recorded; the result stays registered.
  expect(
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
  ).toMatchObject({ outcome: 'created' });
  expect(registerCreated).toHaveBeenCalledTimes(1);
  expect(noteReverify).toHaveBeenCalledWith('intent', 'WRONG_STATE');
  expect(f.state.state).toBe('registered');
  // Exhausted: nothing runs again.
  await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR);
  expect(registerCreated).toHaveBeenCalledTimes(1);
  expect(claimReverify).toHaveBeenCalledTimes(3);
});

it('begins the initial publication when the catalog is recovered as already created', async () => {
  // Production 2026-11-10: the first verification failed before any policy
  // existed; the next pass found the finished catalog and registered it without
  // ever beginning its publication, so the deferred link was never written.
  const f = fixture(false);
  const recovered = {
    outcome: 'created' as const,
    videoShared: true,
    catalog: {
      materialId: 'catalog-material',
      name: 'TR_v1_catalog',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/x',
      sourceLink: body.sourceLink,
      productCount: 2,
      createdAt: null
    }
  };
  f.store.completed = vi.fn(async () => recovered);
  const registerCreated = vi.fn(async () => {});
  f.deps.initialVideoAuthority = {
    serverNow: vi.fn(async () => Date.parse('2026-11-10T19:54:58Z')),
    prepare: vi.fn(),
    registerCreated,
    claimReverify: vi.fn(async () => 'go' as const)
  };
  const request = {
    ...body,
    productCount: 2,
    catalogVideoProtocolVersion: 1,
    restitchEnabled: false,
    videoVariationCount: 1,
    videoPublication: {
      mode: 'scheduled',
      localDateTime: '2026-11-10T21:57',
      timeZone: 'Europe/Kyiv',
      resolvedOffset: '+02:00',
      dueAt: '2026-11-10T19:57:00.000Z'
    }
  };
  expect(
    await createDurableProductCatalog(f.deps, f.store, async () => f.drive, request, ACTOR)
  ).toMatchObject({ outcome: 'created', catalog: { materialId: 'catalog-material' } });
  expect(f.state.state).toBe('registered');
  expect(registerCreated).toHaveBeenCalledTimes(1);
  expect(registerCreated).toHaveBeenCalledWith(
    expect.objectContaining({ intentId: 'intent', catalogMaterialId: 'catalog-material' })
  );
  expect(f.create).not.toHaveBeenCalled();
});
