import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import {
  applyPublicationCells,
  verifyPublicationCells,
  type FrozenPublicationCells
} from '../supabase/functions/catalog-updater/publication-cells';
const frozen: FrozenPublicationCells = {
  fileId: 'file',
  rootFolderId: 'root',
  sheetName: 'catalog_products',
  sheetId: 7,
  idColumn: 0,
  videoColumn: 25,
  idHeaders: ['description', 'id'],
  videoHeaders: ['description', 'video[0].url'],
  products: [
    { id: 'one', url: 'https://example.test/one' },
    { id: 'two', url: 'https://example.test/two' }
  ],
  markerKey: 'soty_pub_job',
  markerValue: 'fence:abc'
};
function drive() {
  return {
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
      ['description', 'id', 'two', 'one'],
      ['description', 'video[0].url', '', '']
    ]),
    writeNativeSpreadsheetCells: vi.fn(async (_input: unknown) => undefined),
    readNativeSpreadsheetMarkers: vi.fn(async () => [] as string[])
  };
}
it('emits only explicit cell-value masks and an atomic receipt, never structural or formatting requests', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ spreadsheetId: 'file', replies: [{}, {}] }))
  );
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await client.writeNativeSpreadsheetCells({
    fileId: 'file',
    updates: [{ sheetId: 7, rowIndex: 2, columnIndex: 25, values: ['https://example.test/one'] }],
    marker: { key: 'soty_pub_job', value: 'fence:abc' }
  });
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body.requests).toEqual([
    {
      updateCells: {
        start: { sheetId: 7, rowIndex: 2, columnIndex: 25 },
        rows: [{ values: [{ userEnteredValue: { stringValue: 'https://example.test/one' } }] }],
        fields: 'userEnteredValue'
      }
    },
    {
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: 'soty_pub_job',
          metadataValue: 'fence:abc',
          visibility: 'DOCUMENT',
          location: { spreadsheet: true }
        }
      }
    }
  ]);
});
it('maps immutable URLs by product identity after reorder and excludes both header rows', async () => {
  const d = drive();
  await applyPublicationCells(d as never, frozen);
  expect(d.writeNativeSpreadsheetCells).toHaveBeenCalledWith({
    fileId: 'file',
    updates: [
      {
        sheetId: 7,
        rowIndex: 2,
        columnIndex: 25,
        values: ['https://example.test/two', 'https://example.test/one']
      }
    ],
    marker: { key: 'soty_pub_job', value: 'fence:abc' }
  });
});
it('rejects changed IDs/headers before any write and never replays an existing receipt', async () => {
  for (const mutation of ['ids', 'headers', 'receipt']) {
    const d = drive();
    if (mutation === 'ids')
      d.readNativeCatalogColumns.mockResolvedValue([
        ['description', 'id', 'two', 'other'],
        ['description', 'video[0].url', '', '']
      ]);
    if (mutation === 'headers')
      d.readNativeCatalogColumns.mockResolvedValue([
        ['description', 'changed', 'two', 'one'],
        ['description', 'video[0].url', '', '']
      ]);
    if (mutation === 'receipt') d.readNativeSpreadsheetMarkers.mockResolvedValue(['fence:abc']);
    await expect(applyPublicationCells(d as never, frozen)).rejects.toThrow();
    expect(d.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
  }
});
it('settles lost acknowledgement only with exact marker and complete matching cells; mismatch stays unknown', async () => {
  const d = drive();
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['fence:abc']);
  d.readNativeCatalogColumns.mockResolvedValue([
    ['description', 'id', 'two', 'one'],
    ['description', 'video[0].url', 'https://example.test/two', 'https://example.test/one']
  ]);
  expect((await verifyPublicationCells(d as never, frozen)).outcome).toBe('verified');
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['different']);
  expect(await verifyPublicationCells(d as never, frozen)).toEqual({ outcome: 'unknown' });
  expect(d.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});
it('names a changed sheet behind our receipt, and still never calls it absent', async () => {
  const d = drive();
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['fence:abc']);
  d.readNativeCatalogColumns.mockResolvedValue([
    ['description', 'id', 'two12', 'one13'],
    ['description', 'video[0].url', 'https://example.test/two', 'https://example.test/one']
  ]);
  expect(await verifyPublicationCells(d as never, frozen)).toEqual({
    outcome: 'unknown',
    reason: 'SOURCE_CHANGED'
  });
  // The same change with no receipt of ours is unknown too, never absent.
  d.readNativeSpreadsheetMarkers.mockResolvedValue([]);
  expect(await verifyPublicationCells(d as never, frozen)).toEqual({
    outcome: 'unknown',
    reason: 'SOURCE_CHANGED'
  });
  expect(d.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});
it('reports absent only when no receipt of this fence exists and the sheet is still readable', async () => {
  // Beta 2026-11-08: the write never left the worker; without `absent` the job stayed unknown forever.
  const d = drive();
  expect(await verifyPublicationCells(d as never, frozen)).toEqual({ outcome: 'absent' });
  const previous = { ...frozen, previousMarker: 'fence:old' };
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['fence:old']);
  expect(await verifyPublicationCells(d as never, previous)).toEqual({ outcome: 'absent' });
  // The previous receipt is gone but ours is not there: someone else changed the sheet.
  d.readNativeSpreadsheetMarkers.mockResolvedValue([]);
  expect(await verifyPublicationCells(d as never, previous)).toEqual({ outcome: 'unknown' });
  // Unreadable or changed sheet is never proof of absence.
  d.readNativeCatalogColumns.mockRejectedValue(new Error('DRIVE_UNAVAILABLE'));
  expect(await verifyPublicationCells(d as never, frozen)).toEqual({ outcome: 'unknown' });
  expect(d.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});
it('replaces only the trusted previously delivered receipt in the same atomic batch', async () => {
  const d = drive();
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['previous-fence']);
  await applyPublicationCells(d as never, { ...frozen, previousMarker: 'previous-fence' });
  expect(d.writeNativeSpreadsheetCells.mock.calls[0]![0]).toMatchObject({
    marker: { key: frozen.markerKey, value: frozen.markerValue, replacesValue: 'previous-fence' }
  });
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ spreadsheetId: 'file', replies: [{}, {}, {}] }))
  );
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await client.writeNativeSpreadsheetCells({
    fileId: 'file',
    updates: [{ sheetId: 7, rowIndex: 2, columnIndex: 25, values: ['https://example.test/one'] }],
    marker: { key: 'soty_video_publication', value: 'new-fence', replacesValue: 'previous-fence' }
  });
  const requests = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).requests;
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual({
    deleteDeveloperMetadata: {
      dataFilter: {
        developerMetadataLookup: {
          metadataKey: 'soty_video_publication',
          metadataValue: 'previous-fence',
          visibility: 'DOCUMENT',
          locationType: 'SPREADSHEET'
        }
      }
    }
  });
  expect(requests[0].updateCells.fields).toBe('userEnteredValue');
  expect(requests[2].createDeveloperMetadata.developerMetadata.metadataValue).toBe('new-fence');
});
it('refuses duplicated receipts even when their value matches the previously delivered fence', async () => {
  const d = drive();
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['previous-fence', 'previous-fence']);
  await expect(
    applyPublicationCells(d as never, { ...frozen, previousMarker: 'previous-fence' })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(d.writeNativeSpreadsheetCells).not.toHaveBeenCalled();
});
it('keeps ordinary native text filtering consistent with the original catalog encoder', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ spreadsheetId: 'file', replies: [{}, {}] }))
  );
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await client.writeNativeSpreadsheetCells({
    fileId: 'file',
    updates: [{ sheetId: 7, rowIndex: 2, columnIndex: 1, values: ['title\u0000\ud800'] }],
    marker: { key: 'soty_catalog_updater', value: 'fence' }
  });
  const cell = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).requests[0].updateCells.rows[0]
    .values[0];
  expect(cell).toEqual({ userEnteredValue: { stringValue: 'title\ufffd' } });
});
it('bounds provider requests with a scoped deadline and keeps the original client usable', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify({ spreadsheetId: 'file', replies: [{}, {}] }));
  });
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  const input = {
    fileId: 'file',
    updates: [{ sheetId: 7, rowIndex: 2, columnIndex: 25, values: ['https://example.test/one'] }],
    marker: { key: 'soty_video_publication', value: 'fence' }
  };
  await expect(
    client.withRequestDeadline(Date.now() - 1).writeNativeSpreadsheetCells(input)
  ).rejects.toThrow('DRIVE_UNAVAILABLE');
  expect(fetcher).not.toHaveBeenCalled();
  await client.writeNativeSpreadsheetCells(input);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

/**
 * The frame (2026-11-20, TR 84_v1): a regular update names the product area of the tab, and
 * the same batch grows a grid someone shortened and empties everything outside the area.
 */
const framed = async (
  frame: { rows: number; columns: number; gridRows: number; gridColumns: number },
  replies: number
) => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          spreadsheetId: 'file',
          replies: Array.from({ length: replies }, () => ({}))
        })
      )
  );
  await new GoogleDriveClient('synthetic-token-long-enough', fetcher).writeNativeSpreadsheetCells({
    fileId: 'file',
    updates: [{ sheetId: 7, rowIndex: 0, columnIndex: 0, values: ['d', 'id', 'one'] }],
    marker: { key: 'soty_catalog_updater', value: 'marker' },
    frame: { sheetId: 7, ...frame }
  });
  return JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).requests as Record<string, any>[];
};

it('empties every row under the last product, and leaves a column added beside the template', async () => {
  const requests = await framed({ rows: 3, columns: 31, gridRows: 172, gridColumns: 33 }, 3);
  expect(requests.map(r => Object.keys(r)[0])).toEqual([
    'updateCells',
    'updateCells',
    'createDeveloperMetadata'
  ]);
  // No `rows`: the field is cleared over the range. Values only, the grid keeps its size.
  expect(requests[0]).toEqual({
    updateCells: {
      range: {
        sheetId: 7,
        startRowIndex: 3,
        endRowIndex: 172,
        startColumnIndex: 0,
        endColumnIndex: 33
      },
      fields: 'userEnteredValue'
    }
  });
  // The two columns someone added: nothing in the batch reaches them in the product rows.
  expect(requests[1]!.updateCells.start).toEqual({ sheetId: 7, rowIndex: 0, columnIndex: 0 });
});

it('grows a grid someone shortened before anything is written into it', async () => {
  const requests = await framed({ rows: 110, columns: 31, gridRows: 40, gridColumns: 28 }, 4);
  expect(requests.slice(0, 2)).toEqual([
    { appendDimension: { sheetId: 7, dimension: 'ROWS', length: 70 } },
    { appendDimension: { sheetId: 7, dimension: 'COLUMNS', length: 3 } }
  ]);
  // Exactly the product area afterwards: nothing is left outside it to empty.
  expect(requests.map(r => Object.keys(r)[0])).toEqual([
    'appendDimension',
    'appendDimension',
    'updateCells',
    'createDeveloperMetadata'
  ]);
});

it('adds nothing to the batch when the grid is exactly the product area', async () => {
  expect(
    (await framed({ rows: 3, columns: 31, gridRows: 3, gridColumns: 31 }, 2)).map(
      r => Object.keys(r)[0]
    )
  ).toEqual(['updateCells', 'createDeveloperMetadata']);
});

it('refuses a frame its own cells do not fit, before any request', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  for (const frame of [
    { sheetId: 7, rows: 2, columns: 31, gridRows: 100, gridColumns: 31 }, // the cells run past it
    { sheetId: 8, rows: 10, columns: 31, gridRows: 100, gridColumns: 31 }, // another tab
    { sheetId: 7, rows: 10, columns: 0, gridRows: 100, gridColumns: 31 },
    { sheetId: 7, rows: 10, columns: 31, gridRows: 0, gridColumns: 31 }
  ])
    await expect(
      client.writeNativeSpreadsheetCells({
        fileId: 'file',
        updates: [{ sheetId: 7, rowIndex: 0, columnIndex: 0, values: ['d', 'id', 'one'] }],
        marker: { key: 'soty_catalog_updater', value: 'marker' },
        frame
      })
    ).rejects.toThrow('INVALID_INPUT');
  expect(fetcher).not.toHaveBeenCalled();
});

it('gives a renamed tab its name back with one narrow request', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ spreadsheetId: 'file', replies: [{}] }))
  );
  const client = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await client.renameNativeSpreadsheetSheet({
    fileId: 'file',
    sheetId: 7,
    title: 'catalog_products'
  });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).requests).toEqual([
    {
      updateSheetProperties: {
        properties: { sheetId: 7, title: 'catalog_products' },
        fields: 'title'
      }
    }
  ]);
  await expect(
    client.renameNativeSpreadsheetSheet({ fileId: 'file', sheetId: 7, title: 'Лист 1' })
  ).rejects.toThrow('INVALID_INPUT');
});

/**
 * The publication lane reads only the product rows (2026-11-20, TR 84_v1). Here the lane's
 * reads go through the real client over a sheet that still has another catalog's 60 links
 * under its two products: asked for the whole column, the provider would answer with all of
 * them; asked for the product rows, it never shows them.
 */
it('publishes into a sheet with another catalog’s links left under the last product', async () => {
  const sheet: Record<string, string[]> = {
    A: ['description', 'id', 'two', 'one'],
    Z: [
      'description',
      'video[0].url',
      'https://example.test/other-catalog.mp4',
      'https://example.test/other-catalog.mp4',
      ...Array.from({ length: 60 }, () => 'https://example.test/other-catalog.mp4')
    ]
  };
  const fetcher = vi.fn<typeof fetch>(async url => {
    const valueRanges = new URL(String(url)).searchParams.getAll('ranges').map(range => {
      const asked = /^catalog_products!([A-Z]+)1:\1(\d+)$/u.exec(range)!;
      return {
        range,
        majorDimension: 'COLUMNS',
        values: [sheet[asked[1]!]!.slice(0, Number(asked[2]))]
      };
    });
    return new Response(JSON.stringify({ spreadsheetId: 'file', valueRanges }));
  });
  const reader = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  const d = {
    ...drive(),
    readNativeCatalogColumns: vi.fn(
      (input: Parameters<typeof reader.readNativeCatalogColumns>[0]) =>
        reader.readNativeCatalogColumns(input)
    )
  };
  await applyPublicationCells(d as never, frozen);
  expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.getAll('ranges')).toEqual([
    'catalog_products!A1:A4',
    'catalog_products!Z1:Z4'
  ]);
  // Each product gets its own link, by id; the 60 cells below are neither read nor written.
  expect(d.writeNativeSpreadsheetCells).toHaveBeenCalledWith(
    expect.objectContaining({
      updates: [
        {
          sheetId: 7,
          rowIndex: 2,
          columnIndex: 25,
          values: ['https://example.test/two', 'https://example.test/one']
        }
      ]
    })
  );
  // And the write is then confirmed over the same sheet.
  sheet.Z!.splice(2, 2, 'https://example.test/two', 'https://example.test/one');
  d.readNativeSpreadsheetMarkers.mockResolvedValue(['fence:abc']);
  expect(await verifyPublicationCells(d as never, frozen)).toMatchObject({ outcome: 'verified' });
});
