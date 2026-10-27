import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCatalogImageName } from '@video-compressor/shared';

const boundary = vi.hoisted(() => ({ reply: undefined as unknown, calls: vi.fn() }));
vi.mock('../apps/web/src/api/team', () => ({
  TeamApiError: class extends Error {
    constructor(
      public code: string,
      public retryable: boolean
    ) {
      super(code);
    }
  },
  invokeTeamFunction: async (
    name: string,
    body: unknown,
    guard: (value: unknown) => boolean,
    options?: unknown
  ) => {
    boundary.calls(name, body, options);
    if (!guard(boundary.reply)) throw new Error('INVALID_RESPONSE');
    return boundary.reply;
  }
}));
import { catalogImageClient, uploadCatalogImage } from '../apps/web/src/api/team-catalog-images';

beforeEach(() => {
  boundary.calls.mockReset();
  boundary.reply = undefined;
});

describe('catalog image API boundary', () => {
  it('uses the same canonical cursor parameter as the backend import detail route', async () => {
    boundary.reply = {
      id: 'job',
      teamId: 'team',
      sourceKind: 'local',
      state: 'running',
      revision: 1,
      counts: { total: 0, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
      entries: [],
      hasMore: false,
      nextCursor: null
    };
    await catalogImageClient.getImport('job', 'entry-cursor');
    expect(boundary.calls).toHaveBeenCalledWith(
      'catalog-images/imports/job?cursor=entry-cursor',
      {},
      { method: 'GET' }
    );
  });
  it('uses the existing authenticated GET boundary and encodes query values', async () => {
    boundary.reply = {
      contractVersion: 2,
      enabled: false,
      importEnabled: false,
      canManage: false,
      mode: 'legacy'
    };
    await expect(catalogImageClient.capabilities('space&other=bad')).resolves.toEqual(
      boundary.reply
    );
    expect(boundary.calls).toHaveBeenCalledWith(
      'catalog-images/capabilities?teamId=space%26other%3Dbad',
      {},
      { method: 'GET' }
    );
  });

  it('does not convert malformed provider metadata into a ready dictionary', async () => {
    boundary.reply = {
      items: [
        {
          id: 'one',
          publicationId: 'publication',
          publicUrl: 'javascript:bad',
          classification: classifyCatalogImageName('hoodie_black_001.jpg'),
          revision: 1
        }
      ],
      total: 1,
      revision: 1,
      hasMore: false,
      nextCursor: null
    };
    await expect(catalogImageClient.dictionary('team')).rejects.toThrow('INVALID_RESPONSE');
  });

  it('starts a local import without Drive credentials or IDs and binds version 2', async () => {
    boundary.reply = {
      id: 'job',
      teamId: 'team',
      sourceKind: 'local',
      state: 'collecting',
      revision: 0,
      counts: { total: 0, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
      entries: [],
      hasMore: false,
      nextCursor: null
    };
    await catalogImageClient.beginImport({
      teamId: 'team',
      sourceKind: 'local',
      idempotencyKey: 'same-intent'
    });
    expect(boundary.calls).toHaveBeenCalledWith(
      'catalog-images/imports',
      {
        teamId: 'team',
        sourceKind: 'local',
        idempotencyKey: 'same-intent',
        contractVersion: 2
      },
      undefined
    );
  });

  it('never uploads a local file to an arbitrary origin supplied in a grant', async () => {
    const controller = new AbortController();
    await expect(
      uploadCatalogImage(
        {
          url: 'https://elsewhere.example/collect',
          headers: {},
          expiresAt: '2099-01-01T00:00:00Z',
          generation: 1
        },
        new File(['private'], 'hoodie_black.jpg'),
        {
          signal: controller.signal,
          onProgress: vi.fn()
        }
      )
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
