import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImageEmbeddingSettings } from '@video-compressor/shared';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), url: vi.fn(), user: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => ({
  requireSupabaseClient: () => ({
    auth: { getUser: mocks.user },
    storage: { from: () => ({ upload: mocks.upload }) }
  })
}));
vi.mock('../apps/web/src/api/client', () => ({
  imageContentUrl: mocks.url,
  importTeamRestitchImage: vi.fn()
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: {} }));
vi.mock('../apps/web/src/stitcher/api', () => ({ fetchCompressorState: vi.fn() }));
import { publishRestitchImages } from '../apps/web/src/team/restitch/images';

const embedding: ImageEmbeddingSettings = {
  enabled: true,
  startEnabled: true,
  endEnabled: false,
  startImages: [
    {
      id: 'a',
      fileName: 'a.png',
      width: 1,
      height: 1,
      size: 1,
      mimeType: 'image/png',
      extension: '.png'
    }
  ],
  endImages: [],
  disabledImageIds: [],
  replaceExisting: true,
  finalDurationMode: 'random-30-40',
  customFinalDurationSeconds: 2700,
  startDurationMode: 'one-frame',
  customStartDurationMs: 100,
  fitMode: 'cover'
};
const publish = () =>
  publishRestitchImages('team', embedding, {
    startImageIds: ['a'],
    endImageIds: []
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null });
  mocks.url.mockResolvedValue('http://localhost/image');
  mocks.upload.mockResolvedValue({ error: null });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image')));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['409', 409])(
  'allows saving an already published immutable image (%s)',
  async statusCode => {
    mocks.upload.mockResolvedValue({ error: { statusCode } });
    await expect(publish()).resolves.toBeUndefined();
  }
);
it('distinguishes a failed storage upload from a missing image', async () => {
  mocks.upload.mockResolvedValue({ error: { statusCode: '403' } });
  await expect(publish()).rejects.toThrow('RESTITCH_IMAGE_UPLOAD_FAILED');
});
it('reports missing local bytes', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
  await expect(publish()).rejects.toThrow('RESTITCH_LOCAL_IMAGE_MISSING');
  expect(mocks.upload).not.toHaveBeenCalled();
});
it('reports loss of the agent connection', async () => {
  mocks.url.mockResolvedValue(null);
  await expect(publish()).rejects.toThrow('RESTITCH_AGENT_UNAVAILABLE');
  expect(mocks.upload).not.toHaveBeenCalled();
});
it('reports a network failure reaching the agent', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(publish()).rejects.toThrow('RESTITCH_AGENT_UNAVAILABLE');
});
it('reports expired authentication separately', async () => {
  mocks.user.mockResolvedValue({ data: { user: null }, error: null });
  await expect(publish()).rejects.toThrow('AUTH_REQUIRED');
});
