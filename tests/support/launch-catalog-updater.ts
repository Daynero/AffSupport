import { expect, vi } from 'vitest';
import {
  runCatalogUpdaterTick,
  type CatalogUpdaterDeps
} from '../../supabase/functions/catalog-updater/worker';
import type { TeamTestDb } from './team-db';

/** Real updater and SQL receipts; only the external Google transport is synthetic. */
export async function updateLaunchCatalog(db: TeamTestDb, catalogId: string) {
  const worker = 'launch-catalog-update-regression';
  const rpc = async (sql: string, args: unknown[]) =>
    (await db.root<{ ok: boolean }>(`select public.${sql} ok`, args))[0].ok;
  let properties: Record<string, string> = {};
  const write = vi.fn(
    async (input: {
      fileId: string;
      bytes: Uint8Array;
      appProperties?: Record<string, string>;
    }) => {
      expect(input.bytes.byteLength).toBeGreaterThan(0);
      properties = input.appProperties ?? {};
      return {} as never;
    }
  );
  const deps: CatalogUpdaterDeps = {
    workerId: worker,
    openRounds: async () =>
      (await db.root<{ n: number }>('select public.service_open_catalog_updater_rounds() n'))[0].n,
    claim: async (limit, lease) =>
      db.root('select * from public.service_claim_catalog_updater_items($1,$2,$3)', [
        worker,
        limit,
        lease
      ]),
    driveFor: async () => ({
      getFile: async (id: string) =>
        ({
          id,
          trashed: false,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          version: '2',
          appProperties: properties
        }) as never,
      updateConvertedFile: write,
      deleteFile: vi.fn().mockRejectedValue(new Error('Unexpected deletion')),
      updateFileMetadata: vi.fn().mockRejectedValue(new Error('Unexpected metadata edit')),
      listAnyonePermissions: vi.fn().mockResolvedValue([]),
      createAnyoneReaderPermission: vi.fn().mockRejectedValue(new Error('Unexpected sharing'))
    }),
    progress: (id, stage) =>
      rpc('service_set_catalog_update_progress($1,$2,$3)', [id, worker, stage]),
    beginWrite: (id, input) =>
      rpc('service_begin_catalog_update_write($1,$2,$3,$4,$5,$6,$7,$8)', [
        id,
        worker,
        input.marker,
        input.baselineVersion,
        input.expectedCount,
        input.swappedCopy,
        input.became.productCount,
        JSON.stringify(input.became.snapshot)
      ]),
    finishWrite: id => rpc('service_finish_catalog_update_write($1)', [id]),
    recordChanges: (id, changes) =>
      rpc('service_record_catalog_update_changes($1,$2,$3)', [id, worker, JSON.stringify(changes)]),
    complete: (id, count, copy, became) =>
      rpc('service_complete_catalog_update($1,$2,$3,$4,$5,$6)', [
        id,
        worker,
        count,
        copy,
        became?.productCount ?? null,
        JSON.stringify(became?.snapshot ?? null)
      ]),
    retry: (id, code, next) =>
      rpc('service_retry_catalog_update($1,$2,$3,$4)', [id, worker, code, next.toISOString()]),
    unknown: (id, code) => rpc('service_mark_catalog_update_unknown($1,$2,$3)', [id, worker, code]),
    markNeedsReauth: vi.fn(),
    claimRetired: async () => [],
    authorizeCleanup: async () => false,
    forgetCopy: async () => false,
    now: Date.now,
    log: vi.fn()
  };
  const summary = await runCatalogUpdaterTick(deps, { budgetMs: 10_000 });
  expect(write).toHaveBeenCalledTimes(1);
  expect(
    (
      await db.root<{ file: string }>(
        'select drive_file_id file from public.team_materials where id=$1',
        [catalogId]
      )
    )[0].file
  ).toBe(write.mock.calls[0][0].fileId);
  return summary;
}
