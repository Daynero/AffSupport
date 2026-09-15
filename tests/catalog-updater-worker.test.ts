import { describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import {
  parseClaimedCatalog,
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

async function sheetIds(bytes: Uint8Array): Promise<number[]> {
  const sheet = await new Promise<string>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.readEntry();
      zip.on('entry', entry => {
        if (entry.fileName !== 'xl/worksheets/sheet1.xml') return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk as Buffer));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
      });
    });
  });
  return [...sheet.matchAll(/<c r="A(\d+)"><v>(\d+)<\/v><\/c>/gu)].map(match => Number(match[2]));
}

function setup(
  options: {
    batches?: unknown[][];
    failFor?: Record<string, TeamFunctionError>;
    completeFalse?: string[];
    clockStepMs?: number;
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
    complete: vi.fn(async (id: string) => !(options.completeFalse ?? []).includes(id)),
    retry: vi.fn(async () => true),
    markNeedsReauth: vi.fn(async () => undefined),
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
    const byFile = Object.fromEntries(written.map(entry => [entry.fileId, entry.bytes]));
    expect(await sheetIds(byFile['drive-a']!)).toEqual([501, 502, 503]);
    expect(await sheetIds(byFile['drive-b']!)).toEqual([1504, 1505, 1506]);
    expect(deps.complete).toHaveBeenCalledWith('a', 1);
    expect(deps.complete).toHaveBeenCalledWith('b', 3);
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
