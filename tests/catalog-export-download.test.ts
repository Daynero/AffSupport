import { expect, it, vi } from 'vitest';
import {
  CATALOG_EXPORT_MAX_BYTES,
  catalogExportFileName,
  catalogExportTool,
  parseCatalogExportTool,
  readCatalogExport,
  prepareCatalogExport
} from '../supabase/functions/drive-transfer/catalog-export';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
it('keeps the export grant bound to one known source version and consumer', () => {
  expect(parseCatalogExportTool(catalogExportTool('agent', '123'))).toEqual({
    consumer: 'agent',
    version: '123'
  });
  expect(parseCatalogExportTool('download:agent')).toBeNull();
  expect(() => catalogExportTool('browser', null)).toThrow('INVALID_RESPONSE');
});
it('exports a spreadsheet through the XLSX API rather than alt=media', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/drive/v3/files/synthetic/export');
    expect(url.searchParams.get('mimeType')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    return new Response(zip);
  });
  const drive = new GoogleDriveClient('synthetic-access-token', fetcher);
  const response = await drive.exportCatalogSpreadsheet({
    fileId: 'synthetic',
    signal: new AbortController().signal
  });
  expect(await readCatalogExport(response, new AbortController().signal)).toEqual(zip);
});
it('reads a bounded chunked export without inventing a stored native file size', async () => {
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(zip.slice(0, 3));
        c.enqueue(zip.slice(3));
        c.close();
      }
    })
  );
  expect(await readCatalogExport(response, new AbortController().signal)).toEqual(zip);
});
it('rejects an oversized declared export without reading the body', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'content-length': String(CATALOG_EXPORT_MAX_BYTES + 1) }
  });
  await expect(readCatalogExport(response, new AbortController().signal)).rejects.toThrow(
    'CATALOG_EXPORT_TOO_LARGE'
  );
  expect(cancel).toHaveBeenCalled();
});
it('rejects a chunked export that exceeds the ceiling and cancels its upstream', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(CATALOG_EXPORT_MAX_BYTES + 1));
      },
      cancel
    })
  );
  await expect(readCatalogExport(response, new AbortController().signal)).rejects.toThrow(
    'CATALOG_EXPORT_TOO_LARGE'
  );
  expect(cancel).toHaveBeenCalled();
});
it('rejects truncated or non-workbook provider output', async () => {
  await expect(
    readCatalogExport(
      new Response(zip, { headers: { 'content-length': '100' } }),
      new AbortController().signal
    )
  ).rejects.toThrow('INVALID_RESPONSE');
  await expect(
    readCatalogExport(new Response('not a workbook'), new AbortController().signal)
  ).rejects.toThrow('INVALID_RESPONSE');
});
it('keeps the extension while bounding unicode names and removing path separators', () => {
  const name = catalogExportFileName('../Каталог/'.repeat(100) + '.csv');
  expect(name.endsWith('.xlsx')).toBe(true);
  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(205);
  expect(name).not.toContain('/');
});

it('checks catalog access again before returning provider bytes', async () => {
  const source = {
    id: 'file',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    version: '1',
    canDownload: true
  };
  const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const exportFile = vi.fn(async () => new Response(zip));
  await expect(
    prepareCatalogExport({
      purpose: 'download_range',
      toolId: catalogExportTool('browser', '1'),
      source,
      allowed,
      export: exportFile,
      reload: async () => source,
      signal: new AbortController().signal
    })
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(allowed).toHaveBeenCalledTimes(2);
});
it('does not export for an old grant, another source version or an unregistered catalog', async () => {
  const source = {
    id: 'file',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    version: '2',
    canDownload: true
  };
  const exportFile = vi.fn(async () => new Response(zip));
  const input = {
    purpose: 'download_range',
    toolId: catalogExportTool('browser', '2'),
    source,
    allowed: async () => false,
    export: exportFile,
    reload: async () => source,
    signal: new AbortController().signal
  };
  await expect(prepareCatalogExport(input)).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    prepareCatalogExport({ ...input, allowed: async () => true, toolId: 'download:browser' })
  ).rejects.toThrow('UNSUPPORTED_MEDIA');
  await expect(
    prepareCatalogExport({
      ...input,
      allowed: async () => true,
      toolId: catalogExportTool('browser', '1')
    })
  ).rejects.toThrow('SOURCE_CHANGED');
  expect(exportFile).not.toHaveBeenCalled();
});
it('refuses export bytes if the source changed or left its authorized root during export', async () => {
  const source = {
    id: 'file',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    version: '1',
    canDownload: true
  };
  const input = {
    purpose: 'download_range',
    toolId: catalogExportTool('agent', '1'),
    source,
    allowed: async () => true,
    export: async () => new Response(zip),
    reload: async () => ({ ...source, version: '2' }),
    signal: new AbortController().signal
  };
  await expect(prepareCatalogExport(input)).rejects.toThrow('SOURCE_CHANGED');
  await expect(
    prepareCatalogExport({
      ...input,
      reload: async () => {
        throw new Error('ROOT_ESCAPE');
      }
    })
  ).rejects.toThrow('ROOT_ESCAPE');
});
