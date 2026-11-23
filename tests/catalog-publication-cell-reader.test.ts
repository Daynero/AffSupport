import { expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
const input = {
  fileId: 'fixture',
  sheetName: 'catalog_products',
  columns: [0, 25],
  rowCount: 1000,
  expectedRows: 4
};
function response(
  values: unknown = {
    spreadsheetId: 'fixture',
    valueRanges: [
      {
        range: 'catalog_products!A1:A1000',
        majorDimension: 'COLUMNS',
        values: [['description', 'id', 'one', 'two']]
      },
      {
        range: 'catalog_products!Z1:Z1000',
        majorDimension: 'COLUMNS',
        values: [['description', 'video']]
      }
    ]
  }
) {
  return new Response(JSON.stringify(values), { headers: { 'content-type': 'application/json' } });
}
it('reads bounded complete columns and interprets provider-omitted trailing empty cells', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response()),
    drive = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  expect(await drive.readNativeCatalogColumns(input)).toEqual([
    ['description', 'id', 'one', 'two'],
    ['description', 'video', '', '']
  ]);
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get('valueRenderOption')).toBe('FORMULA');
  expect(url.searchParams.getAll('ranges')).toHaveLength(2);
});
const idColumn = (values: unknown) => ({
  range: 'catalog_products!A1:A1000',
  majorDimension: 'COLUMNS',
  values
});
const videoColumn = (values: unknown) => ({
  range: 'catalog_products!Z1:Z1000',
  majorDimension: 'COLUMNS',
  values
});
const reading = (valueRanges: unknown[]) =>
  new GoogleDriveClient('synthetic-token-long-enough', async () =>
    response({ spreadsheetId: 'fixture', valueRanges })
  ).readNativeCatalogColumns(input);

it('rejects a reply that is not the two requested ranges, and overlarge grid requests', async () => {
  for (const valueRanges of [
    [],
    // Another range, another orientation, a column the provider left out, two columns for one.
    [
      { ...idColumn([['d', 'id', 'one', 'two']]), range: 'catalog_products!B1:B1000' },
      videoColumn([['d', 'video']])
    ],
    [
      { ...idColumn([['d', 'id', 'one', 'two']]), majorDimension: 'ROWS' },
      videoColumn([['d', 'video']])
    ],
    [idColumn(undefined), videoColumn([['d', 'video']])],
    [
      idColumn([
        ['d', 'id'],
        ['one', 'two']
      ]),
      videoColumn([['d', 'video']])
    ]
  ])
    await expect(reading(valueRanges)).rejects.toThrow('INVALID_RESPONSE');
  const fetcher = vi.fn<typeof fetch>(),
    drive = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await expect(drive.readNativeCatalogColumns({ ...input, rowCount: 10001 })).rejects.toThrow(
    'INVALID_INPUT'
  );
  expect(fetcher).not.toHaveBeenCalled();
});

/**
 * Production 2026-11-20 (DreamTeam, TR 84_v1): the video column of a 170-product catalog was
 * pasted over a 108-product one. The 62 links under the last product read as INVALID_RESPONSE,
 * which says «the server answered unexpectedly, try again» and is retried for good. What the
 * cells hold is the sheet's doing, not the provider's.
 */
it('reads a value under the last product row as a sheet someone changed', async () => {
  const pasted = reading([
    idColumn([['d', 'id', 'one', 'two']]),
    videoColumn([['d', 'video', 'https://v/1', 'https://v/1', 'https://v/1', 'https://v/1']])
  ]);
  await expect(pasted).rejects.toThrow('SOURCE_CHANGED');
  await expect(pasted).rejects.not.toThrow('INVALID_RESPONSE');
  await expect(
    reading([idColumn([['d', 'id', 'one', 'two', 'three']]), videoColumn([['d', 'video']])])
  ).rejects.toThrow('SOURCE_CHANGED');
});

it('reads a cell Soty never writes — a number, a boolean, an oversized text — the same way', async () => {
  // FORMULA rendering returns a typed-in number as a number: only a hand edit produces one.
  for (const cell of [84, true, 'x'.repeat(8193)])
    await expect(
      reading([idColumn([['d', 'id', 'one', 'two']]), videoColumn([['d', 'video', cell]])])
    ).rejects.toThrow('SOURCE_CHANGED');
});

it('accepts a sheet filled exactly to the last product row', async () => {
  expect(
    await reading([
      idColumn([['d', 'id', 'one', 'two']]),
      videoColumn([['d', 'video', 'https://v/1', 'https://v/2']])
    ])
  ).toEqual([
    ['d', 'id', 'one', 'two'],
    ['d', 'video', 'https://v/1', 'https://v/2']
  ]);
});

it('cancels an overlarge provider response before parsing or retaining unbounded cells', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel
  });
  const drive = new GoogleDriveClient(
    'synthetic-token-long-enough',
    async () => new Response(body)
  );
  await expect(drive.readNativeCatalogColumns(input)).rejects.toThrow('INVALID_RESPONSE');
  expect(cancel).toHaveBeenCalledOnce();
});

/**
 * The tolerant form: the sheet is Soty's output and people edit it. A reader that only keeps
 * or locates the product rows takes them as they are and is never shown the rest.
 */
const tolerantly = async (
  valueRanges: unknown[],
  shape: { rowCount?: number; expectedRows?: number } = {}
) => {
  const fetcher = vi.fn<typeof fetch>(async () =>
      response({ spreadsheetId: 'fixture', valueRanges })
    ),
    drive = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  const cells = await drive.readNativeCatalogColumns({ ...input, ...shape, tolerant: true });
  return {
    cells,
    ranges: new URL(String(fetcher.mock.calls[0]![0])).searchParams.getAll('ranges')
  };
};
const range = (column: string, lastRow: number, values?: unknown) => ({
  range: `catalog_products!${column}1:${column}${lastRow}`,
  majorDimension: 'COLUMNS',
  ...(values === undefined ? {} : { values })
});

it('asks a tolerant reader only for the product rows, so nothing under them is ever seen', async () => {
  const { cells, ranges } = await tolerantly([
    range('A', 4, [['d', 'id', 'one', 'two']]),
    range('Z', 4, [['d', 'video', 'https://v/1', 'https://v/1']])
  ]);
  // The grid has a thousand rows and anything may sit in them; four are requested.
  expect(ranges).toEqual(['catalog_products!A1:A4', 'catalog_products!Z1:Z4']);
  expect(cells).toEqual([
    ['d', 'id', 'one', 'two'],
    ['d', 'video', 'https://v/1', 'https://v/1']
  ]);
});

it('reads a grid of any size tolerantly: a huge one, and one shorter than the products', async () => {
  // Ten thousand rows is the strict reader's limit, not the sheet's.
  expect(
    (
      await tolerantly(
        [range('A', 4, [['d', 'id', 'one', 'two']]), range('Z', 4, [['d', 'video']])],
        { rowCount: 250_000 }
      )
    ).ranges
  ).toEqual(['catalog_products!A1:A4', 'catalog_products!Z1:Z4']);
  // Rows were deleted: three are left where four belong. What is missing reads as empty.
  const short = await tolerantly(
    [range('A', 3, [['d', 'id', 'one']]), range('Z', 3, [['d', 'video', 'https://v/1']])],
    { rowCount: 3 }
  );
  expect(short.ranges).toEqual(['catalog_products!A1:A3', 'catalog_products!Z1:Z3']);
  expect(short.cells).toEqual([
    ['d', 'id', 'one', ''],
    ['d', 'video', 'https://v/1', '']
  ]);
});

it('takes whatever a product cell holds — a typed number, nothing, an emptied column', async () => {
  expect(
    (
      await tolerantly([
        range('A', 4, [['d', 'id', 84, true]]),
        // Nothing in the whole range: the provider sends no `values` at all.
        range('Z', 4)
      ])
    ).cells
  ).toEqual([
    ['d', 'id', '84', 'true'],
    ['', '', '', '']
  ]);
  // A cell longer than anything Soty writes is not a link to keep.
  expect(
    (
      await tolerantly([
        range('A', 4, [['d', 'id', 'one', 'two']]),
        range('Z', 4, [['d', 'video', 'x'.repeat(8193), 'https://v/2']])
      ])
    ).cells[1]
  ).toEqual(['d', 'video', '', 'https://v/2']);
});

it('still refuses a tolerant reply that is not the requested ranges', async () => {
  for (const valueRanges of [
    [],
    [range('B', 4, [['d']]), range('Z', 4)],
    [{ ...range('A', 4, [['d']]), majorDimension: 'ROWS' }, range('Z', 4)],
    [range('A', 4, [['d'], ['id']]), range('Z', 4)],
    [range('A', 4, 'not a list'), range('Z', 4)]
  ])
    await expect(tolerantly(valueRanges)).rejects.toThrow('INVALID_RESPONSE');
});
