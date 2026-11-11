import { expect, it, vi } from 'vitest';
import { createTargetedCatalogPublicationIo } from '../supabase/functions/catalog-updater/publication-io';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
const uuid = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
it('bounds and deduplicates 400-row eager provider preparation without any sheet write or new queue', async () => {
  const sources = await Promise.all(
    Array.from({ length: 400 }, async (_, index) => {
      const materialId = uuid(index + 10),
        fileId = 'output_' + index;
      return {
        materialId,
        connectionId: uuid(2),
        fileId,
        credentialId: uuid(3),
        rootFolderId: 'root',
        sourceVersion: await catalogPublicationSourceIdentity({
          materialId,
          connectionId: uuid(2),
          fileId,
          checksum: 'a'.repeat(32),
          mimeType: 'video/mp4',
          sizeBytes: 17,
          driveVersion: '1'
        })
      };
    })
  );
  const links: unknown[] = [];
  const context = () => ({
    state: 'ready',
    phase: 'eager',
    sources,
    links,
    productCount: 400,
    prepared: null
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    error: null,
    data:
      name === 'service_catalog_publication_cells_context'
        ? context()
        : name === 'service_record_catalog_publication_link'
          ? (links.push({
              materialId: args.p_material,
              sourceVersion: args.p_source_version,
              url: args.p_url,
              dueVerified: true
            }),
            true)
          : name === 'service_claim_catalog_publication_preparations'
            ? [{ jobId: uuid(4), teamId: uuid(5), actorId: uuid(6) }]
            : true
  }));
  const drive = {
    getFile: vi.fn(async (id: string) => ({
      id,
      version: '1',
      parents: ['root'],
      trashed: false,
      shortcutTargetId: null,
      resourceKey: null,
      checksum: 'a'.repeat(32),
      mimeType: 'video/mp4',
      size: 17,
      capabilities: { canDownload: true, canShare: true }
    })),
    listAnyonePermissions: vi.fn(async () => [{ id: 'public', type: 'anyone', role: 'reader' }]),
    writeNativeSpreadsheetCells: vi.fn(),
    getNativeSpreadsheetSheets: vi.fn(),
    readNativeSpreadsheetMarkers: vi.fn()
  };
  const io = createTargetedCatalogPublicationIo(
    { rpc } as never,
    uuid(7),
    async () => drive as never
  );
  await io.preparePending!();
  expect(links).toHaveLength(32);
  expect(new Set((links as Array<{ materialId: string }>).map(l => l.materialId)).size).toBe(32);
  expect(drive.getNativeSpreadsheetSheets).not.toHaveBeenCalled();
  expect(drive.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith('service_release_catalog_publication_preparation', {
    p_job: uuid(4),
    p_worker: uuid(7),
    p_error_code: null
  });
});
it('does not restart a slow 400-output validation cohort when early receipts age past five minutes', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2030-01-01T00:20:00Z'));
    const sources = Array.from({ length: 400 }, (_, n) => ({
      materialId: uuid(n + 10),
      sourceVersion: 'immutable-' + n
    }));
    // The server verifies these receipts belong to the same bounded original
    // due epoch; individual proof age is not a client-side rolling-TTL reset.
    const links = sources.map(s => ({
      ...s,
      url: 'https://example.invalid/' + s.materialId,
      dueVerified: true
    }));
    const rpc = vi.fn(async () => ({
      error: null,
      data: {
        state: 'ready',
        phase: 'due',
        sources,
        links,
        productCount: 400,
        prepared: { original: true }
      }
    }));
    const driveFor = vi.fn(async () => {
      throw Error('NO_REPROOF_OR_MEDIA_WORK');
    });
    const io = createTargetedCatalogPublicationIo({ rpc } as never, uuid(7), driveFor);
    expect(
      await io.availability({} as never, { teamId: uuid(1), actorId: uuid(2), jobId: uuid(3) })
    ).toBe('ready');
    expect(driveFor).not.toHaveBeenCalled();
    expect(rpc.mock.calls).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
it('verifies a frozen write in the same pass even after the tick preparation budget ran out', async () => {
  // 1.4.3 QA: the readback right after a write re-ran preparation, hit the tick's
  // seven-second budget before seeing the frozen payload, and returned unknown,
  // so every deferred link cost one more updater tick.
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2030-01-01T00:20:00Z'));
    const fence = uuid(9);
    const frozen = {
      fileId: 'file',
      rootFolderId: 'root',
      sheetName: 'catalog_products',
      sheetId: 7,
      idColumn: 0,
      videoColumn: 25,
      idHeaders: ['description', 'id'],
      videoHeaders: ['description', 'video[0].url'],
      products: [{ id: 'one', url: 'https://example.test/one' }],
      markerKey: 'soty_video_publication',
      markerValue: uuid(3)
    };
    const sources = [{ materialId: uuid(10), sourceVersion: 'immutable-0' }];
    const rpc = vi.fn(async () => ({
      error: null,
      data: {
        state: 'ready',
        phase: 'due',
        sources,
        links: [{ ...sources[0], url: 'https://example.test/one', dueVerified: true }],
        productCount: 1,
        credentialId: uuid(11),
        prepared: frozen
      }
    }));
    const drive = {
      getFile: vi.fn(async (id: string) => ({
        id,
        version: '1',
        parents: id === 'file' ? ['root'] : [],
        mimeType:
          id === 'root'
            ? 'application/vnd.google-apps.folder'
            : 'application/vnd.google-apps.spreadsheet',
        trashed: false,
        capabilities: { canModifyContent: true }
      })),
      getNativeSpreadsheetSheets: vi.fn(async () => [
        { sheetId: 7, title: 'catalog_products', rowCount: 1000, columnCount: 30 }
      ]),
      readNativeCatalogColumns: vi.fn(async () => [
        ['description', 'id', 'one'],
        ['description', 'video[0].url', 'https://example.test/one']
      ]),
      readNativeSpreadsheetMarkers: vi.fn(async () => [fence])
    };
    const io = createTargetedCatalogPublicationIo(
      { rpc } as never,
      uuid(7),
      async () => drive as never
    );
    // Preparation, the reservation and the write used up the tick budget.
    vi.setSystemTime(new Date('2030-01-01T00:20:09Z'));
    const result = await io.verify({} as never, fence, {
      teamId: uuid(1),
      actorId: uuid(2),
      jobId: uuid(3)
    });
    expect(result.outcome).toBe('verified');
  } finally {
    vi.useRealTimers();
  }
});
