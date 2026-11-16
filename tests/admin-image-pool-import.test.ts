import { afterEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/api/team', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/api/team')>()),
  invokeTeamFunction: invoke
}));
vi.mock('../apps/web/src/api/team-catalog-images', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/api/team-catalog-images')>()),
  uploadCatalogImage: upload
}));

import { TeamApiError } from '../apps/web/src/api/team';
import { importPoolImages } from '../apps/web/src/api/catalog-global-pool';

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
  upload.mockReset();
});

/**
 * 052 pilot on next (2026-11-16): staging holds eight files at once and the worker drains
 * them one by one, so a 55-file folder stopped at 47 after about a minute of "busy". The
 * upload must wait the queue out rather than stop.
 */
it('keeps waiting while staging is busy and finishes the folder', async () => {
  // Only setTimeout: the importer hashes names with WebCrypto, which settles on the real loop.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  let busy = 40;
  invoke.mockImplementation((_name: string, body: { action: string }) => {
    switch (body.action) {
      case 'begin':
        return Promise.resolve({ id: 'job', state: 'sealed', entries: [], hasMore: false });
      case 'get':
        return Promise.resolve({
          id: 'job',
          state: 'running',
          entries: [{ id: 'e1', fileKey: FILE_KEY, state: 'waiting_source' }],
          hasMore: false,
          nextCursor: null
        });
      case 'grant':
        return busy-- > 0
          ? Promise.reject(new TeamApiError('IMAGE_UPLOAD_CAPACITY_BUSY' as never, true))
          : Promise.resolve({ url: 'https://upload.invalid', headers: {} });
      default:
        return Promise.resolve({});
    }
  });
  upload.mockResolvedValue(undefined);
  const done = importPoolImages([new File([new Uint8Array(3)], 'blazer_black_001.jpg')], {
    signal: new AbortController().signal,
    onProgress: () => {}
  });
  let settled = false;
  void done.finally(() => (settled = true));
  for (let waited = 0; !settled && waited < 5 * 60_000; waited += 1000) {
    await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1000);
  }
  await expect(done).resolves.toEqual({ jobId: 'job', uploaded: 1 });
  expect(upload).toHaveBeenCalledOnce();
});

// sha256('blazer_black_001.jpg'): the file key the importer derives from the name.
const FILE_KEY = 'ca4f9a9e25a8fcd5d5f597134f57dd336ac720a1301f7eaf6d2f0077ac7b3273';
