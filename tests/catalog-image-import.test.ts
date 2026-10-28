import { describe, expect, it, vi } from 'vitest';
import {
  handleCatalogImages,
  type CatalogImageHandlerDeps
} from '../supabase/functions/catalog-images/handler.js';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.js';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images.js';

const TEAM = '45000000-0000-4000-8000-000000000001';
const ACTOR = '45000000-0000-4000-8000-000000000002';
const JOB = '45000000-0000-4000-8000-000000000003';
const snapshot = {
  id: JOB,
  teamId: TEAM,
  sourceKind: 'local',
  state: 'collecting',
  revision: 1,
  counts: { total: 0, ready: 0, reused: 0, unclassified: 0, failed: 0, expired: 0 },
  entries: [],
  hasMore: false,
  nextCursor: null
};
function deps(): CatalogImageHandlerDeps {
  return {
    enabled: true,
    siteUrl: 'https://soty.test',
    r2: new CatalogImageR2(
      {
        accountId: 'a'.repeat(32),
        stagingBucket: 'staging',
        publicBucket: 'public',
        publicOrigin: 'https://media.test',
        zoneId: 'b'.repeat(32),
        purgeToken: 'private'
      },
      { sign: async request => request }
    ),
    authorize: vi.fn(async () => ACTOR),
    authorizeWorker: vi.fn(async () => undefined),
    runWorker: vi.fn(async () => ({ idle: true })),
    service: { rpc: vi.fn(async () => ({ data: snapshot, error: null })) }
  };
}
const request = (path: string, body: unknown = {}) =>
  new Request(`https://backend.test/functions/v1/catalog-images${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

describe('catalog image control authorization and boundaries', () => {
  it.each(['storage', 'library'] as const)(
    'keeps authenticated %s reads available while uploads are disabled',
    async action => {
      const d = deps();
      d.enabled = false;
      d.r2 = null;
      const value =
        action === 'storage'
          ? {
              limitBytes: 100_000_000,
              limitImages: 500,
              usedBytes: 1000,
              reservedBytes: 0,
              pendingDeletionBytes: 0,
              retainedBytes: 1000,
              libraryBytes: 0,
              totalImages: 1,
              availableBytes: 99_999_000,
              teamBytes: 1000,
              otherTeamBytes: 0
            }
          : { items: [], total: 0, revision: 1, hasMore: false, nextCursor: null };
      d.service.rpc = vi.fn(async () => ({ data: value, error: null }));
      const response = await handleCatalogImages(
        new Request(
          `https://backend.test/functions/v1/catalog-images/${action}?teamId=${TEAM}&cursor=${JOB}`
        ),
        d
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, value });
      expect(d.authorize).toHaveBeenCalledOnce();
      expect(d.service.rpc).toHaveBeenCalledExactlyOnceWith('service_catalog_image_control_v2', {
        p_action: action,
        p_actor: ACTOR,
        p_payload: { teamId: TEAM, cursor: JOB }
      });
      expect(d.runWorker).not.toHaveBeenCalled();
      expect(d.authorizeWorker).not.toHaveBeenCalled();
    }
  );
  it.each(['storage', 'library'] as const)(
    'preserves SQL permission denial for a %s read',
    async action => {
      const d = deps();
      d.service.rpc = vi.fn(async () => ({ data: null, error: { message: 'PERMISSION_DENIED' } }));
      const response = await handleCatalogImages(
        new Request(`https://backend.test/functions/v1/catalog-images/${action}?teamId=${TEAM}`),
        d
      );
      expect(response.status).toBe(403);
      expect(d.runWorker).not.toHaveBeenCalled();
    }
  );
  it.each(['storage', 'library'] as const)(
    'rejects a malformed %s projection rather than returning a false empty balance',
    async action => {
      const d = deps();
      d.service.rpc = vi.fn(async () => ({
        data:
          action === 'storage'
            ? { usedBytes: 0 }
            : {
                items: [
                  {
                    id: 'entry',
                    publicationId: 'publication',
                    publicUrl: 'https://media.test/v1/image',
                    classification: {
                      mode: 'unclassified',
                      garment: null,
                      color: null,
                      reason: 'unknown',
                      vocabularyVersion: 'catalog-clothing-v1'
                    },
                    revision: 1
                  }
                ],
                total: 1,
                revision: 1,
                hasMore: false,
                nextCursor: null
              },
        error: null
      }));
      const response = await handleCatalogImages(
        new Request(`https://backend.test/functions/v1/catalog-images/${action}?teamId=${TEAM}`),
        d
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'INVALID_RESPONSE' }
      });
    }
  );
  it('never accepts worker secret instead of user authentication', async () => {
    const d = deps();
    d.authorize = vi.fn(async () => {
      throw new TeamFunctionError('AUTH_REQUIRED');
    });
    const response = await handleCatalogImages(
      request('/imports', {
        teamId: TEAM,
        contractVersion: 2,
        sourceKind: 'local',
        idempotencyKey: 'request-00001'
      }),
      d
    );
    expect(response.status).toBe(401);
    expect(d.service.rpc).not.toHaveBeenCalled();
    expect(d.authorizeWorker).not.toHaveBeenCalled();
  });
  it('does not accept browser authentication instead of worker secret', async () => {
    const d = deps();
    d.authorizeWorker = vi.fn(async () => {
      throw new TeamFunctionError('AUTH_REQUIRED');
    });
    expect((await handleCatalogImages(request('/worker'), d)).status).toBe(401);
    expect(d.authorize).not.toHaveBeenCalled();
    expect(d.runWorker).not.toHaveBeenCalled();
  });
  it('local import needs no Drive and cannot spoof actor identity', async () => {
    const d = deps();
    const result = await handleCatalogImages(
      request('/imports', {
        teamId: TEAM,
        actorId: TEAM,
        contractVersion: 2,
        sourceKind: 'local',
        idempotencyKey: 'request-00001'
      }),
      d
    );
    expect(result.status).toBe(202);
    expect(d.service.rpc).toHaveBeenCalledWith(
      'service_catalog_image_control_v2',
      expect.objectContaining({
        p_actor: ACTOR,
        p_payload: expect.objectContaining({ sourceKind: 'local' })
      })
    );
  });
  it('keeps ordinary names usable as unclassified rather than rejecting their upload', async () => {
    const d = deps();
    const result = await handleCatalogImages(
      request(`/imports/${JOB}/manifest`, {
        pageKey: 'page-00001',
        entries: [
          {
            name: 'IMG_2031.png',
            clientFileKey: 'file-00001',
            declaredSize: 68,
            declaredMime: 'image/png'
          }
        ]
      }),
      d
    );
    expect(result.status).toBe(200);
    expect(d.service.rpc).toHaveBeenCalledWith(
      'service_catalog_image_control_v2',
      expect.objectContaining({
        p_action: 'manifest',
        p_payload: expect.objectContaining({
          entries: [
            expect.objectContaining({
              classification: expect.objectContaining({
                mode: 'unclassified',
                garment: null,
                color: null
              })
            })
          ]
        })
      })
    );
  });
  it('refuses uploads before any work when feature disabled', async () => {
    const d = deps();
    d.enabled = false;
    expect(
      (
        await handleCatalogImages(
          request('/imports', {
            teamId: TEAM,
            contractVersion: 2,
            sourceKind: 'local',
            idempotencyKey: 'request-00001'
          }),
          d
        )
      ).status
    ).toBe(409);
    expect(d.service.rpc).not.toHaveBeenCalled();
  });
  it('bounds absent-content-length metadata and rejects untrusted browser origins', async () => {
    const d = deps();
    expect(
      (await handleCatalogImages(request('/imports', { excess: 'x'.repeat(1_000_001) }), d)).status
    ).toBe(413);
    const other = request('/imports');
    other.headers.set('origin', 'https://attacker.test');
    expect((await handleCatalogImages(other, d)).status).toBe(403);
  });
});
