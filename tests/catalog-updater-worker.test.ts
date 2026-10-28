/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  classifyCatalogReadback,
  parseClaimedCatalog,
  grownCount,
  runCatalogUpdaterTick,
  type CatalogUpdaterDeps
} from '../supabase/functions/catalog-updater/worker.js';

describe('Drive write reconciliation', () => {
  const file = {
    id: 'sheet',
    trashed: false,
    mimeType: 'application/vnd.google-apps.spreadsheet',
    version: '8',
    appProperties: {} as Record<string, string>
  };
  const expected = { fileId: 'sheet', marker: 'attempt', baselineVersion: '7' };
  it('accepts only the matching private marker as delivered', () => {
    expect(
      classifyCatalogReadback(
        { ...file, appProperties: { sotyCatalogAttempt: 'attempt' } },
        expected
      )
    ).toBe('delivered');
    expect(
      classifyCatalogReadback({ ...file, appProperties: { sotyCatalogAttempt: 'other' } }, expected)
    ).toBe('inconclusive');
  });
  it('permits replay only when Drive still has the baseline version', () => {
    expect(classifyCatalogReadback({ ...file, version: '7' }, expected)).toBe('unchanged');
    expect(classifyCatalogReadback(file, { ...expected, baselineVersion: null })).toBe(
      'inconclusive'
    );
    expect(classifyCatalogReadback({ ...file, trashed: true, version: '7' }, expected)).toBe(
      'inconclusive'
    );
  });
});

/**
 * Feature 023: one tick of the scheduled worker, with the database, Drive and the clock replaced by
 * recording fakes. What must hold: each claimed sheet is written once with its IDs one update on;
 * one sheet's failure is retried on its own and never stops the rest; a lost lease is not treated as
 * a failure; the time budget stops further claims.
 */

function claimedRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    catalog_material_id: id,
    team_id: 'team',
    attempts: 1,
    update_count: 0,
    product_count: 3,
    source_link: 'https://offer.example.test/?sub=1',
    video_link: 'https://drive.google.com/file/d/video/view?usp=sharing',
    settings_snapshot: {
      title: 'Polo',
      description: 'Knit',
      price: 10,
      imageLink: 'https://img.example.test/a.png'
    },
    drive_file_id: `drive-${id}`,
    resource_key: null,
    credential_id: 'cred',
    ...overrides
  };
}

function zipEntry(bytes: Uint8Array, name: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.readEntry();
      zip.on('entry', entry => {
        if (entry.fileName !== name) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk as Buffer));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
      });
    });
  });
}

/** Column A, resolved through the workbook's shared strings: IDs are text since 024 US21. */
async function sheetIds(bytes: Uint8Array): Promise<string[]> {
  const sheet = await zipEntry(bytes, 'xl/worksheets/sheet1.xml');
  const strings = [
    ...(await zipEntry(bytes, 'xl/sharedStrings.xml')).matchAll(/<si><t[^>]*>([^<]*)<\/t><\/si>/gu)
  ].map(match => match[1]!);
  return [...sheet.matchAll(/<c r="A(\d+)" t="s"><v>(\d+)<\/v><\/c>/gu)]
    .filter(match => Number(match[1]) > 2)
    .map(match => strings[Number(match[2])]!);
}

function setup(
  options: {
    batches?: unknown[][];
    failFor?: Record<string, TeamFunctionError>;
    completeFalse?: string[];
    clockStepMs?: number;
    retired?: unknown[];
    deleteFails?: string[];
    readbackMismatch?: boolean;
    readbackVersion?: string;
  } = {}
) {
  const batches = [...(options.batches ?? [[claimedRow('a'), claimedRow('b')]])];
  let clock = 0;
  const written: Array<{ fileId: string; bytes: Uint8Array }> = [];
  let lastAppProperties: Record<string, string> = {};
  const drive = {
    updateConvertedFile: vi.fn(
      async (input: {
        fileId: string;
        bytes: Uint8Array;
        appProperties?: Record<string, string>;
      }) => {
        const id = input.fileId.replace('drive-', '');
        const failure = options.failFor?.[id];
        if (failure) throw failure;
        lastAppProperties = input.appProperties ?? {};
        written.push({ fileId: input.fileId, bytes: input.bytes });
        return {
          id: input.fileId,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          version: '2',
          trashed: false
        } as never;
      }
    ),
    getFile: vi.fn(
      async (fileId: string) =>
        ({
          id: fileId,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          version: options.readbackVersion ?? (options.readbackMismatch ? '1' : '2'),
          appProperties: options.readbackMismatch ? {} : lastAppProperties,
          trashed: false
        }) as never
    ),
    deleteFile: vi.fn(async (fileId: string) => {
      if ((options.deleteFails ?? []).includes(fileId)) throw new TeamFunctionError('RATE_LIMITED');
      return { deleted: true };
    })
  };
  const deps: CatalogUpdaterDeps = {
    workerId: 'worker',
    openRounds: vi.fn(async () => 1),
    claim: vi.fn(async () => {
      clock += options.clockStepMs ?? 0;
      return batches.shift() ?? [];
    }),
    driveFor: vi.fn(async () => drive),
    progress: vi.fn(async () => true),
    beginWrite: vi.fn(async () => true),
    finishWrite: vi.fn(async () => true),
    recordChanges: vi.fn(async () => true),
    complete: vi.fn(async (id: string) => !(options.completeFalse ?? []).includes(id)),
    retry: vi.fn(async () => true),
    unknown: vi.fn(async () => true),
    markNeedsReauth: vi.fn(async () => undefined),
    claimRetired: vi.fn(async () => options.retired ?? []),
    authorizeCleanup: vi.fn(async () => true),
    forgetCopy: vi.fn(async () => true),
    now: () => clock,
    log: vi.fn()
  };
  return { deps, drive, written };
}

describe('a tick', () => {
  it('accepts the matching delivery marker when Drive conversion advances the version again', async () => {
    const { deps } = setup({ readbackVersion: '3', batches: [[claimedRow('a')]] });
    const result = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(result.updated).toBe(1);
    expect(deps.unknown).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous timeout after Drive write unknown without replaying growth', async () => {
    const { deps, drive } = setup({ batches: [[claimedRow('a', { grow_products: true })]] });
    drive.updateConvertedFile = vi.fn(async () => {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.unknown).toHaveBeenCalledWith('a', 'DRIVE_UNAVAILABLE');
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
  it('does not confirm success when Drive readback disagrees with the write', async () => {
    const { deps } = setup({ readbackMismatch: true, batches: [[claimedRow('a')]] });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ updated: 0, failed: 1 });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.recordChanges).not.toHaveBeenCalled();
    expect(deps.beginWrite).toHaveBeenCalledOnce();
    expect(deps.finishWrite).not.toHaveBeenCalled();
    expect(deps.unknown).toHaveBeenCalledWith('a', 'DELIVERY_UNAVAILABLE');
    expect(deps.retry).not.toHaveBeenCalled();
  });
  it('writes original video links and retains the opt-out for later updates', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { random_link_variation: false })]]
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.recordChanges).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({
        productIds: true,
        linksVaried: false,
        productsAdded: false
      })
    );
    expect(deps.beginWrite).toHaveBeenCalledOnce();
    expect(deps.finishWrite).toHaveBeenCalledWith('a');
    const strings = await zipEntry(written[0]!.bytes, 'xl/sharedStrings.xml');
    expect(strings).toContain('https://drive.google.com/file/d/video/view?usp=sharing');
    expect(strings).not.toContain('?v=');
    expect(deps.complete).toHaveBeenCalledWith(
      'a',
      1,
      null,
      expect.objectContaining({ snapshot: expect.objectContaining({ randomLinkVariation: false }) })
    );
    const snapshot = { ...claimedRow('b').settings_snapshot, randomLinkVariation: false };
    expect(
      parseClaimedCatalog(claimedRow('b', { settings_snapshot: snapshot }))?.randomLinkVariation
    ).toBe(false);
    expect(
      parseClaimedCatalog(
        claimedRow('b', { settings_snapshot: snapshot, random_link_variation: true })
      )?.randomLinkVariation
    ).toBe(true);
  });
  it('writes each claimed sheet once with its IDs one update on', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a'), claimedRow('b', { update_count: 2 })]]
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ rounds: 1, claimed: 2, updated: 2, failed: 0 });
    expect(deps.claim).toHaveBeenCalledWith(3, 300);
    expect(deps.progress).toHaveBeenCalledWith('a', 'preparing');
    expect(deps.progress).toHaveBeenCalledWith('a', 'finalizing');
    const byFile = Object.fromEntries(written.map(entry => [entry.fileId, entry.bytes]));
    const idsA = await sheetIds(byFile['drive-a']!);
    const idsB = await sheetIds(byFile['drive-b']!);
    // 024 US21: minted per write, so no two sheets — and no two updates — share one.
    expect(idsA).toHaveLength(3);
    expect(new Set([...idsA, ...idsB]).size).toBe(6);
    expect(idsA.every(id => /^[0-9A-Z]+-[0-9A-Z]{7}$/u.test(id))).toBe(true);
    expect(deps.complete).toHaveBeenCalledWith(
      'a',
      1,
      null,
      expect.objectContaining({ productCount: 3 })
    );
    expect(deps.complete).toHaveBeenCalledWith(
      'b',
      3,
      null,
      expect.objectContaining({ productCount: 3 })
    );
  });

  it('holds only the sheet with an uncertain Drive write and still updates the others', async () => {
    const { deps } = setup({
      batches: [[claimedRow('a'), claimedRow('b', { attempts: 2 }), claimedRow('c')]],
      failFor: { b: new TeamFunctionError('RATE_LIMITED') }
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ updated: 2, failed: 1 });
    expect(deps.unknown).toHaveBeenCalledWith('b', 'RATE_LIMITED');
    expect(deps.retry).not.toHaveBeenCalled();
  });

  it('marks the credential when Google wants the space reconnected', async () => {
    const { deps } = setup({
      batches: [[claimedRow('a')]],
      failFor: { a: new TeamFunctionError('NEEDS_REAUTH') }
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.markNeedsReauth).toHaveBeenCalledWith('cred');
    expect(deps.unknown).toHaveBeenCalledWith('a', 'NEEDS_REAUTH');
  });

  it('does not count a lost lease as a failure', async () => {
    const { deps } = setup({ batches: [[claimedRow('a')]], completeFalse: ['a'] });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ updated: 0, failed: 0, skipped: 1 });
    expect(deps.retry).not.toHaveBeenCalled();
  });

  it('keeps claiming until nothing is due, and stops when the budget is spent', async () => {
    const drained = setup({ batches: [[claimedRow('a')], [claimedRow('b')], []] });
    expect((await runCatalogUpdaterTick(drained.deps, { budgetMs: 8000 })).updated).toBe(2);
    expect(drained.deps.claim).toHaveBeenCalledTimes(3);

    const slow = setup({ batches: [[claimedRow('a')], [claimedRow('b')]], clockStepMs: 5000 });
    const summary = await runCatalogUpdaterTick(slow.deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(2);
    expect(slow.deps.claim).toHaveBeenCalledTimes(2);
  });

  it('skips a claimed row it cannot read instead of writing a wrong sheet', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { settings_snapshot: { title: 'x' } }), claimedRow('b')]]
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ claimed: 1, updated: 1 });
    expect(written.map(entry => entry.fileId)).toEqual(['drive-b']);
    expect(deps.retry).toHaveBeenCalledWith('a', 'INVALID_RESPONSE', expect.any(Date));
  });
});

describe('re-stitched copies', () => {
  const strings = async (bytes: Uint8Array) => zipEntry(bytes, 'xl/sharedStrings.xml');

  it('writes the spare link and swaps to it; without a spare keeps the copy in use', async () => {
    const { deps, written } = setup({
      batches: [
        [
          claimedRow('a', {
            current_video_link: 'https://drive.google.com/file/d/old/view',
            spare_material_id: 'spare-a',
            spare_link: 'https://drive.google.com/file/d/spare/view'
          }),
          claimedRow('b', { current_video_link: 'https://drive.google.com/file/d/inuse/view' }),
          claimedRow('c')
        ]
      ]
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    const byFile = Object.fromEntries(written.map(entry => [entry.fileId, entry.bytes]));
    const a = await strings(byFile['drive-a']!);
    expect(a).toContain('https://drive.google.com/file/d/spare/view');
    expect(a).not.toContain('file/d/old/view');
    expect(await strings(byFile['drive-b']!)).toContain(
      'https://drive.google.com/file/d/inuse/view'
    );
    expect(await strings(byFile['drive-c']!)).toContain('file/d/video/view');
    expect(deps.complete).toHaveBeenCalledWith('a', 1, 'spare-a', expect.anything());
    expect(deps.complete).toHaveBeenCalledWith('b', 1, null, expect.anything());
  });

  it('ignores a spare without a link', () => {
    expect(
      parseClaimedCatalog(claimedRow('a', { spare_material_id: 'spare-a', spare_link: null }))
        ?.spare
    ).toBeNull();
  });

  it('does not delete a claimed copy when authority is lost before the provider request', async () => {
    const { deps, drive } = setup({
      batches: [[]],
      retired: [{ material_id: 'm1', drive_file_id: 'f1', credential_id: 'cred' }]
    });
    deps.authorizeCleanup = vi.fn(async () => false);
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.authorizeCleanup).toHaveBeenCalledWith('m1', 'retired');
    expect(drive.deleteFile).not.toHaveBeenCalled();
    expect(deps.forgetCopy).not.toHaveBeenCalled();
    expect(summary.deletedCopies).toBe(0);
  });

  it('deletes only the retired copies it was handed, and records a failed try', async () => {
    const { deps, drive } = setup({
      batches: [[]],
      retired: [
        { material_id: 'm1', drive_file_id: 'f1', credential_id: 'cred' },
        { material_id: 'm2', drive_file_id: 'f2', credential_id: 'cred' },
        { material_id: 'm3' }
      ],
      deleteFails: ['f2']
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.deletedCopies).toBe(1);
    expect(drive.deleteFile.mock.calls.map(call => call[0])).toEqual(['f1', 'f2']);
    expect(deps.forgetCopy).toHaveBeenCalledWith('m1', true);
    expect(deps.forgetCopy).toHaveBeenCalledWith('m2', false);
  });

  it('leaves deletions for the next tick when the budget is spent', async () => {
    const { deps } = setup({
      batches: [[claimedRow('a')], []],
      clockStepMs: 9000,
      retired: [{ material_id: 'm1', drive_file_id: 'f1', credential_id: 'cred' }]
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.claimRetired).not.toHaveBeenCalled();
  });
});

describe('reading a claimed row', () => {
  it('accepts a row as the database returns it, including numeric strings', () => {
    expect(
      parseClaimedCatalog(claimedRow('a', { product_count: '3', update_count: '4' }))
    ).toMatchObject({
      catalogId: 'a',
      productCount: 3,
      updateCount: 4,
      settings: { price: 10 }
    });
  });

  it('refuses a row without a sheet or with a zero product count', () => {
    expect(parseClaimedCatalog(claimedRow('a', { drive_file_id: null }))).toBeNull();
    expect(parseClaimedCatalog(claimedRow('a', { product_count: 0 }))).toBeNull();
    expect(parseClaimedCatalog('nope')).toBeNull();
  });
});

describe('refreshing pictures (024)', () => {
  it('checks a large picture pool concurrently with a bounded Drive fan-out', async () => {
    const { deps, drive } = setup({
      batches: [[claimedRow('a', { product_count: 100, refresh_images: true })]]
    });
    let active = 0;
    let peak = 0;
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return [{ id: 'p', role: 'reader' }];
      }),
      createAnyoneReaderPermission: vi.fn()
    });
    deps.drawImages = vi.fn(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        driveFileId: `img-${index}`,
        resourceKey: null
      }))
    );

    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });

    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it('draws the rows pictures afresh from the pool and shares them', async () => {
    const { deps, drive, written } = setup({
      batches: [[claimedRow('a', { refresh_images: true })]]
    });
    const shared = new Set<string>();
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async (fileId: string) =>
        shared.has(fileId) ? [{ id: 'p', role: 'reader' }] : []
      ),
      createAnyoneReaderPermission: vi.fn(async (fileId: string) => {
        shared.add(fileId);
        return { id: 'p', role: 'reader' };
      })
    });
    deps.drawImages = vi.fn(async () => [
      { driveFileId: 'img-1', resourceKey: null },
      { driveFileId: 'img-2', resourceKey: null },
      { driveFileId: 'img-3', resourceKey: null }
    ]);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.drawImages).toHaveBeenCalledWith(
      'team',
      3,
      expect.objectContaining({ contractVersion: 2, scope: 'refresh' })
    );
    const sheet = await zipEntryAny(written[0]!.bytes);
    expect(sheet).toContain('id=img-2');
    expect(sheet).not.toContain('img.example.test');
  });

  it('keeps the pictures it had when the refresh is off', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { refresh_images: false })]]
    });
    deps.drawImages = vi.fn(async () => [{ driveFileId: 'img-1', resourceKey: null }]);
    deps.readImageLink = vi.fn(async () => 'https://i.postimg.cc/example/new.jpg');
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.drawImages).not.toHaveBeenCalled();
    expect(deps.readImageLink).not.toHaveBeenCalled();
    expect(await zipEntryAny(written[0]!.bytes)).toContain('img.example.test');
  });

  it('replaces historical Drive images with the current space link when the image pool was removed', async () => {
    const { deps, drive, written } = setup({
      batches: [[claimedRow('a', { refresh_images: true })]]
    });
    deps.drawImages = vi.fn(async () => []);
    deps.readImageLink = vi.fn(async () => 'https://i.postimg.cc/example/new.jpg');
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.readImageLink).toHaveBeenCalledWith('team');
    const sheet = await zipEntryAny(written[0]!.bytes);
    expect(sheet).toContain('https://i.postimg.cc/example/new.jpg');
    expect(sheet).not.toContain('https://img.example.test/a.png');
    expect(deps.recordChanges).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ imagesRefreshed: true })
    );
    expect(deps.beginWrite).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({
        became: expect.objectContaining({
          snapshot: expect.objectContaining({ imageLink: 'https://i.postimg.cc/example/new.jpg' })
        })
      })
    );
    expect(drive.listAnyonePermissions).toBeUndefined();
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it('does not treat a failed pool read as an empty pool or publish old images as a refresh', async () => {
    const { deps, written } = setup({ batches: [[claimedRow('a', { refresh_images: true })]] });
    deps.drawImages = vi.fn(async () => {
      throw new TeamFunctionError('DRIVE_UNAVAILABLE');
    });
    deps.readImageLink = vi.fn(async () => 'https://i.postimg.cc/example/new.jpg');
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(written).toHaveLength(0);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.retry).toHaveBeenCalledOnce();
  });

  it('retains previous images when the pool and current space fallback are both empty', async () => {
    const { deps, written } = setup({ batches: [[claimedRow('a', { refresh_images: true })]] });
    deps.drawImages = vi.fn(async () => []);
    deps.readImageLink = vi.fn(async () => null);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(await zipEntryAny(written[0]!.bytes)).toContain('img.example.test');
  });

  it('uses the current fallback for newly added products without changing existing images when refresh is off', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { refresh_images: false, grow_products: true })]]
    });
    deps.drawImages = vi.fn(async () => []);
    deps.readImageLink = vi.fn(async () => 'https://i.postimg.cc/example/new.jpg');
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    const sheet = await zipEntryAny(written[0]!.bytes);
    expect(sheet).toContain('img.example.test');
    expect(sheet).toContain('https://i.postimg.cc/example/new.jpg');
    expect(deps.readImageLink).toHaveBeenCalledOnce();
  });
});

describe('refreshing names, texts and prices (024, US21)', () => {
  it('draws a fresh pair and a fresh price for every row, and re-reads the name', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { refresh_texts: true, price_min: 40, price_max: 40 })]]
    });
    deps.drawTexts = vi.fn(async () => [
      { title: 'Ludia Navy Twill Wide Leg Jeans', description: 'Holds its shape.' }
    ]);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.drawTexts).toHaveBeenCalledWith('team', 3);
    const sheet = await zipEntryAny(written[0]!.bytes);
    expect(sheet).toContain('Ludia Navy Twill Wide Leg Jeans');
    expect(sheet).toContain('40,00 USD');
    expect(sheet).not.toContain('Polo');
    // The details follow the new name rather than the one the catalog was made with.
    expect(sheet).toContain('navy');
    expect(sheet).toContain('Apparel &amp; Accessories &gt; Clothing &gt; Pants');
  });

  it('keeps the price it had when the space keeps no range', async () => {
    const { deps, written } = setup({ batches: [[claimedRow('a', { refresh_texts: true })]] });
    deps.drawTexts = vi.fn(async () => [
      { title: 'Nova Sage Jersey Hoodie', description: 'Soft.' }
    ]);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(await zipEntryAny(written[0]!.bytes)).toContain('10,00 USD');
  });

  it('keeps the words it had when the refresh is off', async () => {
    const { deps, written } = setup({ batches: [[claimedRow('a', { refresh_texts: false })]] });
    deps.drawTexts = vi.fn(async () => [{ title: 'Other', description: 'Other.' }]);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.drawTexts).not.toHaveBeenCalled();
    expect(await zipEntryAny(written[0]!.bytes)).toContain('Polo');
  });
});

describe('growing a catalog (024, US22)', () => {
  it('adds one to five products, with names and pictures of their own, and records the new count', async () => {
    const { deps, drive, written } = setup({
      batches: [[claimedRow('a', { grow_products: true, price_min: 12, price_max: 12 })]]
    });
    const shared = new Set<string>();
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async (fileId: string) =>
        shared.has(fileId) ? [{ id: 'p', role: 'reader' }] : []
      ),
      createAnyoneReaderPermission: vi.fn(async (fileId: string) => {
        shared.add(fileId);
        return { id: 'p', role: 'reader' };
      })
    });
    deps.drawTexts = vi.fn(async (_team: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `Ludia Navy Twill Wide Leg Jeans ${index}`,
        description: 'Holds its shape.'
      }))
    );
    deps.drawImages = vi.fn(async (_team: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        driveFileId: `img-${index}`,
        resourceKey: null
      }))
    );
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    const grown = vi.mocked(deps.complete).mock.calls[0]![3] as {
      productCount: number;
      snapshot: { rows: unknown[] };
    };
    expect(grown.productCount).toBeGreaterThan(3);
    expect(grown.productCount).toBeLessThanOrEqual(8);
    // The rows travel with the count, or the next update would fall back to the single values.
    expect(grown.snapshot.rows).toHaveLength(grown.productCount);
    const ids = await sheetIds(written[0]!.bytes);
    expect(ids).toHaveLength(grown.productCount);
    expect(new Set(ids).size).toBe(grown.productCount);
    // A new product is a product: its own picture, shared by link, and its own price.
    expect(drive.createAnyoneReaderPermission).toHaveBeenCalled();
    expect(await zipEntryAny(written[0]!.bytes)).toContain('12,00 USD');
  });

  it('adds nothing when the tick is off', async () => {
    const { deps } = setup({ batches: [[claimedRow('a', { grow_products: false })]] });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(vi.mocked(deps.complete).mock.calls[0]![3]).toMatchObject({ productCount: 3 });
  });

  it('never grows past the four hundred a sheet may hold', () => {
    expect(grownCount(400, true, () => 0.99)).toBe(400);
    expect(grownCount(398, true, () => 0.99)).toBe(400);
    expect(grownCount(10, true, () => 0)).toBe(11);
    expect(grownCount(10, false, () => 0.99)).toBe(10);
  });
});

describe('clearing what a deleted video left (024, US24)', () => {
  it('puts the sheet and the text in Drive’s bin, and says so to the database', async () => {
    const { deps, drive } = setup({ batches: [[]] });
    const trashed: string[] = [];
    Object.assign(drive, {
      updateFileMetadata: vi.fn(async (input: { fileId: string; trashed?: boolean }) => {
        if (input.trashed) trashed.push(input.fileId);
        return { id: input.fileId };
      })
    });
    deps.claimOrphans = vi
      .fn()
      .mockResolvedValueOnce([
        {
          material_id: 'm1',
          team_id: 'team',
          drive_file_id: 'drive-sheet',
          credential_id: 'cred',
          companion_kind: 'product_catalog',
          name: 'clip_v1_catalog'
        },
        {
          material_id: 'm2',
          team_id: 'team',
          drive_file_id: 'drive-text',
          credential_id: 'cred',
          companion_kind: 'transcript',
          name: 'clip.txt'
        }
      ])
      .mockResolvedValue([]);
    deps.clearOrphan = vi.fn(async () => true);
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(trashed).toEqual(['drive-sheet', 'drive-text']);
    expect(deps.clearOrphan).toHaveBeenCalledWith('m1', true);
    expect(summary.clearedOrphans).toBe(2);
  });

  it('keeps the queue entry when Drive refuses', async () => {
    const { deps, drive } = setup({ batches: [[]] });
    Object.assign(drive, {
      updateFileMetadata: vi.fn(async () => {
        throw new TeamFunctionError('RATE_LIMITED');
      })
    });
    deps.claimOrphans = vi.fn().mockResolvedValueOnce([
      {
        material_id: 'm1',
        team_id: 'team',
        drive_file_id: 'drive-sheet',
        credential_id: 'cred',
        companion_kind: 'product_catalog',
        name: 'clip_v1_catalog'
      }
    ]);
    deps.clearOrphan = vi.fn(async () => false);
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.clearOrphan).toHaveBeenCalledWith('m1', false);
    expect(summary.clearedOrphans).toBe(0);
  });
});

async function zipEntryAny(bytes: Uint8Array): Promise<string> {
  const names = ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'];
  const parts = await Promise.all(names.map(name => zipEntry(bytes, name).catch(() => '')));
  return parts.join('\n');
}
describe('catalog refresh preparation', () => {
  it('draws texts while images are pending, then matches texts to the final pictures', async () => {
    const { deps, drive, written } = setup({
      batches: [[claimedRow('a', { product_count: 100 })]]
    });
    let resolveImages!: (
      value: Array<{ driveFileId: string; resourceKey: null; name: string }>
    ) => void;
    const pendingImages = new Promise<
      Array<{ driveFileId: string; resourceKey: null; name: string }>
    >(resolve => {
      resolveImages = resolve;
    });
    deps.drawImages = vi.fn(() => pendingImages);
    deps.drawTexts = vi.fn(async () => {
      // A sequential draw deadlocks here; resolving pictures depends on starting the text draw.
      resolveImages(
        Array.from({ length: 100 }, (_, index) => ({
          driveFileId: `img-${index}`,
          resourceKey: null,
          name: 'Hoodie_Black.png'
        }))
      );
      return Array.from({ length: 100 }, () => ({ title: 'Hoodie', description: 'Fresh' }));
    });
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async () => [{ id: 'p', role: 'reader' }]),
      createAnyoneReaderPermission: vi.fn()
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(1);
    expect(deps.drawTexts).toHaveBeenCalledWith('team', 100);
    const rows = deps.complete.mock.calls[0][3].snapshot.rows;
    expect(rows).toHaveLength(100);
    expect(
      rows.every(row => row.title === 'Hoodie' && row.pictureName === 'Hoodie_Black.png')
    ).toBe(true);
    expect(await sheetIds(written[0].bytes)).toHaveLength(100);
  });

  it('checks a repeated growth/refresh image once per attempt, and rechecks next round', async () => {
    const { deps, drive } = setup({
      batches: [
        [claimedRow('a', { grow_products: true })],
        [claimedRow('b', { grow_products: true })]
      ]
    });
    deps.drawImages = vi.fn(async () => [{ driveFileId: 'same-image', resourceKey: null }]);
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async () => [{ id: 'p', role: 'reader' }]),
      createAnyoneReaderPermission: vi.fn()
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(2);
    expect(deps.drawImages).toHaveBeenCalledTimes(4);
    expect(drive.listAnyonePermissions).toHaveBeenCalledTimes(2);
  });

  it('waits for a pending text draw before recording an image failure', async () => {
    const { deps, drive } = setup({ batches: [[claimedRow('a')]] });
    let release!: () => void;
    let failureReached!: () => void;
    const atFailure = new Promise<void>(resolve => {
      failureReached = resolve;
    });
    const texts = new Promise<Array<{ title: string; description: string }>>(resolve => {
      release = () => resolve([]);
    });
    deps.drawTexts = vi.fn(() => texts);
    deps.drawImages = vi.fn(async () => [{ driveFileId: 'image', resourceKey: null }]);
    Object.assign(drive, {
      listAnyonePermissions: vi.fn(async () => {
        failureReached();
        throw new TeamFunctionError('RATE_LIMITED');
      }),
      createAnyoneReaderPermission: vi.fn()
    });
    const pending = runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    await atFailure;
    await Promise.resolve();
    expect(deps.retry).not.toHaveBeenCalled();
    release();
    const summary = await pending;
    expect(summary.failed).toBe(1);
    expect(deps.retry).toHaveBeenCalledWith('a', 'RATE_LIMITED', expect.any(Date));
    expect(drive.updateConvertedFile).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
});
// @ts-nocheck — fixture mocks intentionally model only the drive surface used by each case.

describe('R2 ready dictionary integration', () => {
  it('validates retained images during a text-only round and refuses revoked URLs before writing', async () => {
    const retained = {
      kind: 'r2',
      publicationId: 'retained-publication',
      poolEntryId: 'retained-pool',
      publicUrl: 'https://media.example/retained.jpg',
      classification: {
        mode: 'unclassified',
        garment: null,
        color: null,
        reason: 'unknown',
        vocabularyVersion: 'catalog-clothing-v1'
      },
      revision: 1
    };
    const recipe = {
      title: 'Clothing item',
      description: 'Generic clothing.',
      price: 10,
      imageLink: retained.publicUrl,
      pictureImage: retained
    };
    const { deps, drive } = setup({
      batches: [
        [
          claimedRow('a', {
            refresh_images: false,
            refresh_texts: true,
            settings_snapshot: { ...recipe, rows: [recipe, recipe, recipe] }
          })
        ]
      ]
    });
    deps.drawImages = vi.fn(async () => []);
    deps.validateImageRows = vi.fn(async () => {
      throw new TeamFunctionError('IMAGE_PUBLICATION_REVOKED');
    });
    const result = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(result.updated).toBe(0);
    expect(drive.updateConvertedFile).not.toHaveBeenCalled();
    expect(deps.drawImages).not.toHaveBeenCalled();
    expect(deps.validateImageRows).toHaveBeenCalledWith('team', [retained, retained, retained]);
    expect(deps.retry).toHaveBeenCalledWith('a', 'IMAGE_PUBLICATION_REVOKED', expect.any(Date));
  });
  it('parks malformed image snapshots without starving another claimed catalog', async () => {
    const invalid = {
      title: 'Hoodie',
      description: 'Clothing',
      price: 10,
      imageLink: 'https://media.example/old.jpg',
      pictureImage: { kind: 'r2', publicUrl: 'javascript:bad' }
    };
    const { deps, drive } = setup({
      batches: [
        [
          claimedRow('bad', {
            settings_snapshot: { ...invalid, rows: [invalid, invalid, invalid] }
          }),
          claimedRow('good')
        ]
      ]
    });
    const result = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
    expect(deps.retry).toHaveBeenCalledWith('bad', 'INVALID_RESPONSE', expect.any(Date));
    expect(drive.updateConvertedFile).toHaveBeenCalledTimes(1);
    expect(drive.updateConvertedFile.mock.calls[0][0].fileId).toBe('drive-good');
  });
  const picture = (mode = 'matched') => ({
    kind: 'r2',
    publicationId: 'publication',
    poolEntryId: 'pool',
    publicUrl: 'https://media.example/image.jpg',
    revision: 1,
    classification:
      mode === 'matched'
        ? {
            mode: 'matched',
            garment: 'Hoodie',
            color: 'black',
            vocabularyVersion: 'catalog-clothing-v1'
          }
        : {
            mode: 'unclassified',
            garment: null,
            color: null,
            reason: 'unknown',
            vocabularyVersion: 'catalog-clothing-v1'
          }
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    'keeps facts consistent with refresh images=%s and refresh texts=%s',
    async (refreshImages, refreshTexts) => {
      const old = picture();
      const fresh = {
        ...picture(),
        publicUrl: 'https://media.example/polo.jpg',
        classification: {
          mode: 'matched',
          garment: 'Polo Shirt',
          color: 'white',
          vocabularyVersion: 'catalog-clothing-v1'
        }
      };
      const recipe = {
        title: 'Black Hoodie Model',
        description: 'A black hoodie for daily wear.',
        imageLink: old.publicUrl,
        pictureImage: old,
        price: 10
      };
      const { deps } = setup({
        batches: [
          [
            claimedRow('a', {
              refresh_images: refreshImages,
              refresh_texts: refreshTexts,
              settings_snapshot: { ...recipe, rows: [recipe, recipe, recipe] }
            })
          ]
        ]
      });
      deps.drawImages = vi.fn(async () => [fresh, fresh, fresh]);
      deps.drawTexts = vi.fn(async () =>
        Array.from({ length: 3 }, () => ({
          title: 'Ivory Blazer Model',
          description: 'An ivory blazer for daily wear.'
        }))
      );
      const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
      expect(summary.updated).toBe(1);
      const rows = deps.complete.mock.calls[0][3].snapshot.rows;
      expect(
        rows.every(r => r.imageLink === (refreshImages ? fresh.publicUrl : old.publicUrl))
      ).toBe(true);
      expect(rows.every(r => r.title.includes(refreshImages ? 'Polo Shirt' : 'Hoodie'))).toBe(true);
      expect(
        rows.every(r => r.description.toLowerCase().includes(refreshImages ? 'white' : 'black'))
      ).toBe(true);
      expect(deps.drawImages).toHaveBeenCalledTimes(refreshImages ? 1 : 0);
      expect(deps.drawTexts).toHaveBeenCalledTimes(refreshTexts ? 1 : 0);
    }
  );
  it('rejects revoked frozen uses before changing the existing sheet', async () => {
    const { deps, drive } = setup({
      batches: [[claimedRow('a', { image_attempt_id: 'attempt' })]]
    });
    deps.validateImageUses = vi.fn(async () => {
      throw new TeamFunctionError('IMAGE_PUBLICATION_REVOKED');
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(0);
    expect(drive.updateConvertedFile).not.toHaveBeenCalled();
    expect(deps.retry).toHaveBeenCalledWith('a', 'IMAGE_PUBLICATION_REVOKED', expect.any(Date));
  });
  it('uses verified public images without changing Drive image sharing', async () => {
    const { deps, drive } = setup({ batches: [[claimedRow('a')]] });
    drive.listAnyonePermissions = vi.fn(async () => []);
    drive.createAnyoneReaderPermission = vi.fn(async () => undefined);
    deps.drawImages = vi.fn(async () => [picture('unclassified')]);
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(1);
    expect(drive.listAnyonePermissions).not.toHaveBeenCalled();
    expect(drive.createAnyoneReaderPermission).not.toHaveBeenCalled();
    const rows = deps.complete.mock.calls[0][3].snapshot.rows;
    expect(
      rows.every(
        r =>
          r.imageLink === 'https://media.example/image.jpg' &&
          r.pictureImage.classification.mode === 'unclassified'
      )
    ).toBe(true);
  });
  it('does not replace the catalog when image-only matching would guess custom text', async () => {
    const { deps, written } = setup({ batches: [[claimedRow('a', { refresh_texts: false })]] });
    deps.drawImages = vi.fn(async () => [picture()]);
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary.updated).toBe(0);
    expect(written).toHaveLength(0);
    expect(deps.retry).toHaveBeenCalledWith('a', 'IMAGE_TEXT_PAIRING_CONFLICT', expect.any(Date));
  });
});
