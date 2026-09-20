/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  parseClaimedCatalog,
  grownCount,
  runCatalogUpdaterTick,
  type CatalogUpdaterDeps
} from '../supabase/functions/catalog-updater/worker.js';

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
  } = {}
) {
  const batches = [...(options.batches ?? [[claimedRow('a'), claimedRow('b')]])];
  let clock = 0;
  const written: Array<{ fileId: string; bytes: Uint8Array }> = [];
  const drive = {
    updateConvertedFile: vi.fn(async (input: { fileId: string; bytes: Uint8Array }) => {
      const id = input.fileId.replace('drive-', '');
      const failure = options.failFor?.[id];
      if (failure) throw failure;
      written.push({ fileId: input.fileId, bytes: input.bytes });
      return {} as never;
    }),
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
    complete: vi.fn(async (id: string) => !(options.completeFalse ?? []).includes(id)),
    retry: vi.fn(async () => true),
    markNeedsReauth: vi.fn(async () => undefined),
    claimRetired: vi.fn(async () => options.retired ?? []),
    forgetCopy: vi.fn(async () => true),
    now: () => clock,
    log: vi.fn()
  };
  return { deps, drive, written };
}

describe('a tick', () => {
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

  it('retries only the sheet that failed, with its back-off, and still updates the others', async () => {
    const { deps } = setup({
      batches: [[claimedRow('a'), claimedRow('b', { attempts: 2 }), claimedRow('c')]],
      failFor: { b: new TeamFunctionError('RATE_LIMITED') }
    });
    const summary = await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(summary).toMatchObject({ updated: 2, failed: 1 });
    expect(deps.retry).toHaveBeenCalledTimes(1);
    const [id, code, next] = vi.mocked(deps.retry).mock.calls[0]!;
    expect([id, code]).toEqual(['b', 'RATE_LIMITED']);
    expect((next as Date).getTime()).toBe(300_000); // second attempt → 5 minutes
  });

  it('marks the credential when Google wants the space reconnected', async () => {
    const { deps } = setup({
      batches: [[claimedRow('a')]],
      failFor: { a: new TeamFunctionError('NEEDS_REAUTH') }
    });
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.markNeedsReauth).toHaveBeenCalledWith('cred');
    expect(deps.retry).toHaveBeenCalledWith('a', 'NEEDS_REAUTH', expect.any(Date));
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
    expect(deps.drawImages).toHaveBeenCalledWith('team', 3);
    const sheet = await zipEntryAny(written[0]!.bytes);
    expect(sheet).toContain('id=img-2');
    expect(sheet).not.toContain('img.example.test');
  });

  it('keeps the pictures it had when the refresh is off', async () => {
    const { deps, written } = setup({
      batches: [[claimedRow('a', { refresh_images: false })]]
    });
    deps.drawImages = vi.fn(async () => [{ driveFileId: 'img-1', resourceKey: null }]);
    await runCatalogUpdaterTick(deps, { budgetMs: 8000 });
    expect(deps.drawImages).not.toHaveBeenCalled();
    expect(await zipEntryAny(written[0]!.bytes)).toContain('img.example.test');
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
// @ts-nocheck — fixture mocks intentionally model only the drive surface used by each case.
