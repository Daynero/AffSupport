import type { DriveFileMetadata } from '../supabase/functions/_shared/drive';
import { catalogPublicationSourceIdentity } from '../packages/shared/src/team/catalog-publication-source';
import { expect, it, vi } from 'vitest';
import {
  verifyCatalogVideoBaseline,
  handleCatalogPublicationVerify,
  handleCatalogPublicationVerifyRead,
  parseCatalogBaselineVideoSets
} from '../supabase/functions/drive-ops/catalog-publication-baseline';
import {
  PRODUCT_CATALOG_TEMPLATE,
  PRODUCT_CATALOG_SHEET_NAME
} from '../supabase/functions/_shared/product-catalog';
const SOURCE_MATERIAL = '77000000-0000-4000-8000-000000000111';
const SOURCE_CONNECTION = '77000000-0000-4000-8000-000000000112';
const SOURCE_VERSION = await catalogPublicationSourceIdentity({
  materialId: SOURCE_MATERIAL,
  connectionId: SOURCE_CONNECTION,
  fileId: 'source-file',
  checksum: null,
  mimeType: 'video/mp4',
  sizeBytes: null,
  driveVersion: '1'
});
const capabilities = {
  canDownload: true,
  canListChildren: true,
  canAddChildren: true,
  canRename: true,
  canMoveItemWithinDrive: true,
  canMoveItemOutOfDrive: true,
  canModifyContent: true,
  canTrash: true,
  canUntrash: true
};
const sourceLink = 'https://drive.google.com/file/d/source-file/view';
function setup() {
  const ids = PRODUCT_CATALOG_TEMPLATE.find(c => c.source.kind === 'contentId')!,
    video = PRODUCT_CATALOG_TEMPLATE.find(c => c.source.kind === 'videoLink')!;
  const columns = [
    [ids.description, ids.key, 'opaque1', 'opaque2'],
    [video.description, video.key, sourceLink + '?v=a', sourceLink + '?v=b']
  ];
  const catalogDrive = {
    getFile: vi.fn(async (): Promise<Partial<DriveFileMetadata>> => ({
      id: 'catalog-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      version: '2',
      capabilities
    })),
    getNativeSpreadsheetSheets: vi.fn(async () => [
      {
        sheetId: 0,
        title: PRODUCT_CATALOG_SHEET_NAME,
        rowCount: 1000,
        columnCount: PRODUCT_CATALOG_TEMPLATE.length
      }
    ]),
    readNativeCatalogColumns: vi.fn(async () => columns)
  };
  const sourceDrive = {
    listAnyonePermissions: vi.fn(async () => [{ id: 'anyone', role: 'reader' }]),
    getFile: vi.fn(async (): Promise<Partial<DriveFileMetadata>> => ({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      capabilities
    }))
  };
  const scope = {
    catalogMaterialId: 'catalog-material',
    catalogFileId: 'catalog-file',
    catalogResourceKey: null,
    sourceMaterialId: SOURCE_MATERIAL,
    sourceFileId: 'source-file',
    sourceResourceKey: null,
    sourceVersion: SOURCE_VERSION,
    sourceConnectionId: SOURCE_CONNECTION,
    sourceLink,
    catalogRootFolderId: 'root',
    sourceRootFolderId: 'root',
    productCount: 2
  };
  const authorize = vi.fn(async () => {});
  return {
    columns,
    catalogDrive,
    sourceDrive,
    scope,
    authorize,
    input: {
      catalogDrive: catalogDrive as never,
      sourceDrive: sourceDrive as never,
      scope,
      authorize
    }
  };
}
it('derives a verified original source from actual cells without exposing their contents', async () => {
  const h = setup(),
    r = await verifyCatalogVideoBaseline(h.input);
  expect(r.outcome).toBe('source');
  expect(r.videoCellsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(r)).not.toContain(sourceLink);
  expect(JSON.stringify(r)).not.toContain('opaque1');
  expect(h.authorize).toHaveBeenCalledTimes(2);
  expect(h.catalogDrive.readNativeCatalogColumns).toHaveBeenCalledWith(
    expect.objectContaining({ rowCount: 1000, expectedRows: 4 })
  );
});
it('recognizes a verified initial blank without fabricating active delivery', async () => {
  const h = setup();
  h.columns[1]![2] = '';
  h.columns[1]![3] = '';
  expect(await verifyCatalogVideoBaseline(h.input)).toMatchObject({
    outcome: 'blank',
    target: null
  });
});
it('rejects missing rows, mixed links, formulas and a different source binding', async () => {
  for (const change of [
    (h: ReturnType<typeof setup>) => {
      h.columns[0]![3] = '';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = '';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = '=HYPERLINK("' + sourceLink + '")';
    },
    (h: ReturnType<typeof setup>) => {
      h.columns[1]![2] = 'https://drive.google.com/file/d/other/view';
    }
  ]) {
    const h = setup();
    change(h);
    await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  }
});
it('refuses source/catalog changes and revoked access during readback', async () => {
  const h = setup();
  h.sourceDrive.getFile
    .mockResolvedValueOnce({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      capabilities
    })
    .mockResolvedValueOnce({
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '2',
      capabilities
    });
  await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('SOURCE_CHANGED');
  const revoked = setup();
  revoked.authorize.mockResolvedValueOnce().mockRejectedValueOnce(Error('PERMISSION_DENIED'));
  await expect(verifyCatalogVideoBaseline(revoked.input)).rejects.toThrow('PERMISSION_DENIED');
});
it('keeps baseline recovery an exact readonly lookup without provider activity', async () => {
  const id = '77000000-0000-4000-8000-000000000001',
    rpc = vi.fn(async () => ({ data: null, error: null }));
  expect(
    await handleCatalogPublicationVerifyRead({ rpc }, id, {
      teamId: id,
      catalogId: id,
      requestId: id,
      expectedActorId: id
    })
  ).toBeNull();
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith(
    'service_read_catalog_baseline_check',
    expect.objectContaining({ p_check: id, p_actor: id })
  );
});

it('exposes a proven aborted baseline as a definite retryable new observation boundary', async () => {
  const id = '77000000-0000-4000-8000-000000000001',
    rpc = vi.fn(async () => ({ data: null, error: { message: 'WRONG_STATE' } }));
  await expect(
    handleCatalogPublicationVerifyRead({ rpc }, id, {
      teamId: id,
      catalogId: id,
      requestId: id,
      expectedActorId: id
    })
  ).rejects.toThrow('WRONG_STATE');
  expect(rpc).toHaveBeenCalledOnce();
});

it('does not mistake owner OAuth access for public accessibility of an existing video link', async () => {
  const h = setup();
  h.sourceDrive.listAnyonePermissions.mockResolvedValueOnce([]);
  await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('PERMISSION_DENIED');
});

it('accepts a publication-only sharing bump when immutable content identity remains proven', async () => {
  const h = setup(),
    metadata = {
      id: 'source-file',
      parents: ['root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      checksum: 'a'.repeat(32),
      mimeType: 'video/mp4',
      size: 31,
      capabilities
    };
  h.scope.sourceVersion = await catalogPublicationSourceIdentity({
    materialId: SOURCE_MATERIAL,
    connectionId: SOURCE_CONNECTION,
    fileId: 'source-file',
    checksum: metadata.checksum,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.size,
    driveVersion: '1'
  });
  h.sourceDrive.getFile
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, version: '2' });
  expect((await verifyCatalogVideoBaseline(h.input)).outcome).toBe('source');
  const changed = setup();
  changed.scope.sourceVersion = h.scope.sourceVersion;
  changed.sourceDrive.getFile
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce({ ...metadata, checksum: 'b'.repeat(32) });
  await expect(verifyCatalogVideoBaseline(changed.input)).rejects.toThrow('SOURCE_CHANGED');
});

// 1.4.3: a restitched catalog's cells hold its video set's variant outputs, not
// the original; the check recognizes them instead of always refusing.
const SET = '77000000-0000-4000-8000-000000000201',
  VARIANT_A = '77000000-0000-4000-8000-000000000202',
  VARIANT_B = '77000000-0000-4000-8000-000000000203',
  VARIANT_CREDENTIAL = '77000000-0000-4000-8000-000000000204',
  R2_URL = 'https://media.example.invalid/v/' + 'c'.repeat(32) + '.mp4';
const variantLink = (file: string) => `https://drive.google.com/file/d/${file}/view?usp=sharing`;
function variantSetup(rows: boolean | 'swapped' = true) {
  const h = setup();
  h.columns[1]![2] = variantLink('variant-a') + '&v=1';
  h.columns[1]![3] = variantLink('variant-b');
  const variantDrive = {
    getFile: vi.fn(async (id: string): Promise<Partial<DriveFileMetadata>> => ({
      id,
      parents: ['variants-root'],
      shortcutTargetId: null,
      trashed: false,
      version: '1',
      capabilities
    })),
    listAnyonePermissions: vi.fn(async () => [{ id: 'anyone', role: 'reader' }])
  };
  const variant = (materialId: string, fileId: string, r2Urls: string[] = []) => ({
    materialId,
    fileId,
    resourceKey: null,
    credentialId: VARIANT_CREDENTIAL,
    rootFolderId: 'variants-root',
    r2Urls
  });
  const set = {
    videoSetId: SET,
    recipeRevision: 1,
    variants: [variant(VARIANT_A, 'variant-a'), variant(VARIANT_B, 'variant-b', [R2_URL])],
    rows: rows
      ? [
          { productId: 'opaque1', materialId: rows === 'swapped' ? VARIANT_B : VARIANT_A },
          { productId: 'opaque2', materialId: rows === 'swapped' ? VARIANT_A : VARIANT_B }
        ]
      : null
  };
  const scope = { ...h.scope, videoSets: [set] };
  const variantDriveFor = vi.fn(async () => variantDrive as never);
  return {
    ...h,
    set,
    variantDrive,
    variantDriveFor,
    input: { ...h.input, scope, variantDrive: variantDriveFor }
  };
}
it('verifies a restitched catalog whose every row holds its assigned variant', async () => {
  const h = variantSetup();
  const r = await verifyCatalogVideoBaseline(h.input);
  expect(r).toMatchObject({
    outcome: 'video_set',
    target: { kind: 'video_set', videoSetId: SET, recipeRevision: 1 }
  });
  // Each Drive output is proven live and public under its own connection.
  expect(h.variantDriveFor).toHaveBeenCalledWith(VARIANT_CREDENTIAL);
  expect(h.variantDrive.listAnyonePermissions).toHaveBeenCalledWith('variant-a');
  expect(h.variantDrive.listAnyonePermissions).toHaveBeenCalledWith('variant-b');
  // The original's sharing is not what these cells publish.
  expect(h.sourceDrive.listAnyonePermissions).not.toHaveBeenCalled();
});
it('accepts an R2 copy of a variant and any variant when no per-row record exists', async () => {
  const h = variantSetup(false);
  h.columns[1]![2] = variantLink('variant-b');
  h.columns[1]![3] = R2_URL;
  expect((await verifyCatalogVideoBaseline(h.input)).outcome).toBe('video_set');
  expect(h.variantDrive.listAnyonePermissions).toHaveBeenCalledTimes(1);
});
it('refuses a foreign link, a variant on the wrong row, a partly empty column and a non-public variant', async () => {
  const foreign = variantSetup();
  foreign.columns[1]![3] = variantLink('someone-else');
  await expect(verifyCatalogVideoBaseline(foreign.input)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  const swapped = variantSetup('swapped');
  await expect(verifyCatalogVideoBaseline(swapped.input)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  const mixed = variantSetup();
  mixed.columns[1]![3] = '';
  await expect(verifyCatalogVideoBaseline(mixed.input)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  const unknownR2 = variantSetup(false);
  unknownR2.columns[1]![3] = 'https://media.example.invalid/v/' + 'd'.repeat(32) + '.mp4';
  await expect(verifyCatalogVideoBaseline(unknownR2.input)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  const original = variantSetup();
  original.columns[1]![3] = sourceLink;
  await expect(verifyCatalogVideoBaseline(original.input)).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  const closed = variantSetup();
  closed.variantDrive.listAnyonePermissions.mockResolvedValueOnce([]);
  await expect(verifyCatalogVideoBaseline(closed.input)).rejects.toThrow('PERMISSION_DENIED');
});
it('keeps the original-link rule for a catalog that also has a set', async () => {
  const h = variantSetup();
  h.columns[1]![2] = sourceLink;
  h.columns[1]![3] = sourceLink + '?v=b';
  expect(await verifyCatalogVideoBaseline(h.input)).toMatchObject({
    outcome: 'source',
    target: { kind: 'source', materialId: SOURCE_MATERIAL }
  });
  expect(h.variantDriveFor).not.toHaveBeenCalled();
});
it('refuses when the adopted set lost a variant before the final authorization', async () => {
  const h = variantSetup();
  h.authorize
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([{ ...h.set, variants: [h.set.variants[0]!] }] as never);
  await expect(verifyCatalogVideoBaseline(h.input)).rejects.toThrow('SOURCE_CHANGED');
});
it('parses the server candidate sets strictly and treats their absence as none', () => {
  expect(parseCatalogBaselineVideoSets(undefined)).toEqual([]);
  const set = variantSetup().set;
  expect(parseCatalogBaselineVideoSets([set])).toEqual([set]);
  expect(
    parseCatalogBaselineVideoSets([
      { ...set, variants: [{ ...set.variants[0]!, r2Urls: ['https://x.invalid/a'] }] }
    ])
  ).toBeNull();
  expect(parseCatalogBaselineVideoSets([{ ...set, rows: [{ productId: '' }] }])).toBeNull();
});
it('adopts the proven set through finish with its id and recipe revision', async () => {
  const id = '77000000-0000-4000-8000-000000000001',
    fence = '77000000-0000-4000-8000-000000000301',
    credential = '77000000-0000-4000-8000-000000000302';
  const h = variantSetup();
  const ctx = {
    ...h.scope,
    checkId: id,
    fence,
    catalogCredentialId: credential,
    sourceCredentialId: credential,
    sourceMaterialId: SOURCE_MATERIAL,
    catalogMaterialId: id,
    videoSets: [h.set]
  };
  const calls: [string, Record<string, unknown>][] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === 'service_finish_catalog_baseline_check')
      return { data: { not: 'a snapshot' }, error: null };
    return { data: ctx, error: null };
  });
  const drive = {
    getNativeSpreadsheetSheets: h.catalogDrive.getNativeSpreadsheetSheets,
    readNativeCatalogColumns: h.catalogDrive.readNativeCatalogColumns,
    listAnyonePermissions: h.variantDrive.listAnyonePermissions,
    getFile: vi.fn(async (fileId: string) =>
      fileId === 'catalog-file'
        ? h.catalogDrive.getFile()
        : fileId === 'source-file'
          ? h.sourceDrive.getFile()
          : h.variantDrive.getFile(fileId)
    )
  };
  await expect(
    handleCatalogPublicationVerify(
      { rpc },
      id,
      { teamId: id, catalogId: id, requestId: id, expectedActorId: id, expectedRevision: 1 },
      async () => drive as never
    )
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  const finish = calls.find(([name]) => name === 'service_finish_catalog_baseline_check');
  expect(finish?.[1]).toMatchObject({
    p_outcome: 'video_set',
    p_video_set: SET,
    p_recipe_revision: 1
  });
});
