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
  it('reads owner-account storage through the authenticated GET boundary with strict numeric fields', async () => {
    boundary.reply = {
      limitBytes: 100_000_000,
      limitImages: 500,
      usedBytes: 3000,
      reservedBytes: 1000,
      pendingDeletionBytes: 1000,
      retainedBytes: 0,
      libraryBytes: 1000,
      totalImages: 3,
      availableBytes: 99_997_000,
      teamBytes: 2000,
      otherTeamBytes: 1000
    };
    await expect(catalogImageClient.readStorage('team&unexpected=x')).resolves.toEqual(
      boundary.reply
    );
    expect(boundary.calls).toHaveBeenCalledWith(
      'catalog-images/storage?teamId=team%26unexpected%3Dx',
      {},
      { method: 'GET' }
    );
    const valid = boundary.reply as Record<string, unknown>;
    for (const value of [-1, '0', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      boundary.reply = { ...valid, usedBytes: value };
      await expect(catalogImageClient.readStorage('team')).rejects.toThrow('INVALID_RESPONSE');
    }
    const missing = { ...valid };
    delete missing.retainedBytes;
    boundary.reply = missing;
    await expect(catalogImageClient.readStorage('team')).rejects.toThrow('INVALID_RESPONSE');
  });
  it('reads paged library metadata without weakening the existing dictionary contract', async () => {
    const entry = {
      id: 'one',
      publicationId: 'publication',
      publicUrl: 'https://media.example/v1/one',
      classification: classifyCatalogImageName('hoodie_black_001.jpg'),
      revision: 2,
      sizeBytes: 1234,
      active: false,
      inUse: true,
      publicationState: 'ready'
    };
    const page = { items: [entry], total: 1, revision: 2, hasMore: false, nextCursor: null };
    boundary.reply = page;
    await expect(catalogImageClient.readLibrary('team', 'next&cursor=x')).resolves.toEqual(page);
    expect(boundary.calls).toHaveBeenCalledWith(
      'catalog-images/library?teamId=team&cursor=next%26cursor%3Dx',
      {},
      { method: 'GET' }
    );
    for (const patch of [
      { sizeBytes: -1 },
      { active: null },
      { inUse: 'true' },
      { publicationState: 'revoked' }
    ]) {
      boundary.reply = { ...page, items: [{ ...entry, ...patch }] };
      await expect(catalogImageClient.readLibrary('team')).rejects.toThrow('INVALID_RESPONSE');
    }
    const oldEntry: Record<string, unknown> = { ...entry };
    for (const key of ['sizeBytes', 'active', 'inUse', 'publicationState']) delete oldEntry[key];
    boundary.reply = { ...page, items: [oldEntry] };
    await expect(catalogImageClient.readLibrary('team')).rejects.toThrow('INVALID_RESPONSE');
    await expect(catalogImageClient.dictionary('team')).resolves.toEqual(boundary.reply);
  });
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
