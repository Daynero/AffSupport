import { expect, it, vi } from 'vitest';
import {
  betaNativeCatalogSheets,
  nativeCatalogCellRows
} from '../supabase/functions/_shared/catalog-native-sheet';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';

it('enables the experiment only for testing OAuth and the local beta site and origins', () => {
  const beta = {
    enabled: 'true',
    oauthMode: 'testing',
    siteUrl: 'http://127.0.0.1:5175',
    requestOrigin: 'http://127.0.0.1:43140'
  };
  expect(betaNativeCatalogSheets(beta)).toBe(true);
  expect(betaNativeCatalogSheets({ ...beta, requestOrigin: 'http://127.0.0.1:5175' })).toBe(true);
  for (const change of [
    { oauthMode: 'verified' },
    { enabled: undefined },
    { enabled: 'false' },
    { enabled: true },
    { siteUrl: 'https://soty.pp.ua' },
    { siteUrl: 'http://127.0.0.1:5173' },
    { requestOrigin: 'https://soty.pp.ua' },
    { requestOrigin: 'http://127.0.0.1:5173' },
    { requestOrigin: undefined }
  ])
    expect(betaNativeCatalogSheets({ ...beta, ...change })).toBe(false);
});

it('writes literal formula-like text, long IDs and leading zeros as explicit strings', () => {
  expect(
    nativeCatalogCellRows([
      [
        { t: 'string', v: '=IMPORTXML("https://private.invalid","//x")' },
        { t: 'string', v: '000880609123456789' },
        { t: 'string', v: 'a\u0000&<\nb' },
        { t: 'number', v: 100 },
        { t: 'decimal', v: '12.50' },
        { t: 'string', v: '' }
      ]
    ])[0]!.values
  ).toEqual([
    { userEnteredValue: { stringValue: '=IMPORTXML("https://private.invalid","//x")' } },
    { userEnteredValue: { stringValue: '000880609123456789' } },
    { userEnteredValue: { stringValue: 'a&<\nb' } },
    { userEnteredValue: { numberValue: 100 } },
    {
      userEnteredValue: { numberValue: 12.5 },
      userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } }
    },
    {}
  ]);
  expect(() => nativeCatalogCellRows([[{ t: 'number', v: Infinity }]])).toThrow();
  expect(() => nativeCatalogCellRows([[{ t: 'decimal', v: '900719925474099.99' }]])).toThrow(
    'FINANCE_EXPORT_PRECISION'
  );
});

it('creates the marked native file in its final folder before any Sheets call', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'sheet',
        name: 'qa',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: ['folder'],
        trashed: false,
        capabilities: {},
        appProperties: { 'soty.catalog.intent': 'intent' }
      })
    )
  );
  const drive = new GoogleDriveClient('test-token-long-enough', fetcher);
  expect(
    (
      await drive.createNativeSpreadsheet({
        name: 'qa',
        parentId: 'folder',
        appProperties: { 'soty.catalog.intent': 'intent' }
      })
    ).id
  ).toBe('sheet');
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain('www.googleapis.com/drive/v3/files?');
  expect(JSON.parse(init!.body as string)).toMatchObject({
    parents: ['folder'],
    appProperties: { 'soty.catalog.intent': 'intent' }
  });
});

it('uses actual sheet IDs and one atomic typed write without shrinking unrelated grid cells', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          spreadsheetId: 'sheet',
          sheets: [
            {
              properties: {
                sheetId: 173,
                title: 'Sheet1',
                sheetType: 'GRID',
                gridProperties: { rowCount: 2000, columnCount: 40 }
              }
            }
          ]
        })
      )
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ spreadsheetId: 'sheet', replies: [{}, {}] }))
    );
  const drive = new GoogleDriveClient('test-token-long-enough', fetcher);
  const [sheet] = await drive.getNativeSpreadsheetSheets('sheet');
  await drive.writeNativeSpreadsheetRows({
    fileId: 'sheet',
    sheet: sheet!,
    sheetName: 'catalog_products',
    rows: [[{ t: 'string', v: '=1+2' }]]
  });
  const [url, init] = fetcher.mock.calls[1]!;
  expect(String(url)).toBe('https://sheets.googleapis.com/v4/spreadsheets/sheet:batchUpdate');
  const payload = JSON.parse(init!.body as string);
  expect(payload.requests[0].updateSheetProperties.properties).toMatchObject({
    sheetId: 173,
    title: 'catalog_products',
    gridProperties: { rowCount: 2000, columnCount: 40 }
  });
  expect(payload.requests[1].updateCells).toMatchObject({
    start: { sheetId: 173 },
    rows: [{ values: [{ userEnteredValue: { stringValue: '=1+2' } }] }]
  });
  expect(JSON.stringify(payload)).not.toContain('formulaValue');
});
