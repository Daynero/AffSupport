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
it('rejects missing ranges, extra nonempty product rows and overlarge grid requests', async () => {
  for (const values of [
    { spreadsheetId: 'fixture', valueRanges: [] },
    {
      spreadsheetId: 'fixture',
      valueRanges: [
        {
          range: 'catalog_products!A1:A1000',
          majorDimension: 'COLUMNS',
          values: [['d', 'id', 'one', 'two', 'unexpected']]
        },
        { range: 'catalog_products!Z1:Z1000', majorDimension: 'COLUMNS', values: [['d', 'video']] }
      ]
    }
  ]) {
    const drive = new GoogleDriveClient('synthetic-token-long-enough', async () =>
      response(values)
    );
    await expect(drive.readNativeCatalogColumns(input)).rejects.toThrow('INVALID_RESPONSE');
  }
  const fetcher = vi.fn<typeof fetch>(),
    drive = new GoogleDriveClient('synthetic-token-long-enough', fetcher);
  await expect(drive.readNativeCatalogColumns({ ...input, rowCount: 10001 })).rejects.toThrow(
    'INVALID_INPUT'
  );
  expect(fetcher).not.toHaveBeenCalled();
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
