import { describe, expect, it, vi } from 'vitest';
import { GoogleDriveClient } from '../supabase/functions/_shared/drive';
import { providerFile, listingPages } from './fixtures/catalog-sync';

function client(payload: unknown) {
  return new GoogleDriveClient(
    'test-token-long-enough',
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
  );
}

describe('Drive listing coverage', () => {
  it('captures an opaque bootstrap token in the selected Drive before recovery scanning', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ startPageToken: 'opaque/not-a-number' }), { status: 200 })
      );
    const drive = new GoogleDriveClient('test-token-long-enough', fetcher);
    expect(await drive.getStartPageToken('shared-drive')).toBe('opaque/not-a-number');
    const [request] = fetcher.mock.calls[0]!;
    expect(request).toBeInstanceOf(URL);
    if (!(request instanceof URL)) throw new Error('Expected a provider URL');
    expect(request.pathname).toBe('/drive/v3/changes/startPageToken');
    expect(request.searchParams.get('driveId')).toBe('shared-drive');
    expect(request.searchParams.get('supportsAllDrives')).toBe('true');
  });
  it.each([{}, { startPageToken: 1 }, { startPageToken: '' }])(
    'rejects an unusable bootstrap position',
    async payload => {
      await expect(client(payload).getStartPageToken(null)).rejects.toThrow('INVALID_RESPONSE');
    }
  );
  it.each([{ id: '' }, { name: '' }, { name: 'n'.repeat(1025) }, { parents: [''] }])(
    'counts metadata that catalog storage would discard as incomplete',
    async malformed => {
      const result = await client({ files: [providerFile(malformed)] }).listChildren({
        parentId: 'root'
      });
      expect(result).toMatchObject({ files: [], invalidEntries: 1, complete: false });
    }
  );
  it('carries the same coverage diagnostics in folder-only listings', async () => {
    const result = await client({
      files: [providerFile(), { id: 'invalid' }],
      incompleteSearch: true
    }).listFolders({ parentId: 'root' });
    expect(result).toMatchObject({ invalidEntries: 1, incompleteSearch: true, complete: false });
  });
  it('reports malformed entries without losing readable siblings', async () => {
    const result = await client({ files: [providerFile(), { id: 'unreadable' }] }).listChildren({
      parentId: 'root'
    });
    expect(result.files).toHaveLength(1);
    expect(result).toMatchObject({ invalidEntries: 1, incompleteSearch: false, complete: false });
  });
  it('never mistakes incompleteSearch for a complete empty directory', async () => {
    const result = await client({ files: [], incompleteSearch: true }).listChildren({
      parentId: 'root'
    });
    expect(result).toMatchObject({ files: [], incompleteSearch: true, complete: false });
  });
  it('accepts a legitimately empty complete directory', async () => {
    expect(await client({ files: [] }).listChildren({ parentId: 'root' })).toMatchObject({
      complete: true,
      invalidEntries: 0,
      nextPageToken: null
    });
  });
  it('distinguishes a valid page from completed pagination', async () => {
    const pages = listingPages(201);
    const read = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(pages.shift()), { status: 200 }));
    const drive = new GoogleDriveClient('test-token-long-enough', read);
    let pageToken: string | null = null;
    let count = 0;
    do {
      const page = await drive.listChildren({ parentId: 'root', pageToken });
      count += page.files.length;
      expect(page.complete).toBe(page.nextPageToken === null);
      pageToken = page.nextPageToken;
    } while (pageToken);
    expect(count).toBe(201);
  });
  it.each([
    { files: [], nextPageToken: 12 },
    { files: [], incompleteSearch: 'false' }
  ])('rejects malformed pagination/coverage flags', async payload => {
    await expect(client(payload).listChildren({ parentId: 'root' })).rejects.toThrow(
      'INVALID_RESPONSE'
    );
  });
});
