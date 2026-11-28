import { describe, expect, it, vi } from 'vitest';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import { createCatalogImageSpaceSources } from '../supabase/functions/catalog-images/space-sources';
import {
  runCatalogImageWorker,
  type CatalogImageWorkerDeps
} from '../supabase/functions/catalog-images/worker';

/**
 * 057 T040/T041: the catalog picture pool imports from the files of an R2 space. A page of the
 * space's pictures becomes the same entries a Drive enumeration stages (with a `space` source),
 * and a staged picture is read from the space bucket by its content id, never from Drive.
 */

const TEAM = '05745000-0000-4000-8000-000000000001';
const ACTOR = '05745000-0000-4000-8000-000000000002';
const JOB = '05745000-0000-4000-8000-000000000003';
const SOURCE = '05745000-0000-4000-8000-000000000004';
const A = '05745000-0000-4000-8000-00000000000a';
const B = '05745000-0000-4000-8000-00000000000b';
const CONTENT = 'd'.repeat(64);

const item = (id: string, name: string, size = 1200) => ({
  materialId: id,
  name,
  size,
  mime: 'image/png',
  contentId: CONTENT
});
const claim = (overrides: Record<string, unknown> = {}) => ({
  kind: 'enumerate',
  sourceKind: 'space',
  jobId: JOB,
  teamId: TEAM,
  actorId: ACTOR,
  fence: 3,
  cursor: [SOURCE],
  sources: [SOURCE],
  admittedCount: 0,
  admittedBytes: 0,
  ...overrides
});

describe('catalog pictures from an R2 space', () => {
  it('stages a page of the space pictures as the Drive enumeration does', async () => {
    const rpc = vi.fn(async () => ({
      items: [item(A, 'polo-white.png'), item(B, 'shirt.png')],
      hasMore: false
    }));
    const sources = createCatalogImageSpaceSources({ rpc, space: null });
    const page = await sources.enumerateSpace(claim(), 'worker-1', new AbortController().signal);
    expect(rpc).toHaveBeenCalledWith('service_catalog_image_space_enumerate', {
      p_job: JOB,
      p_worker: 'worker-1',
      p_fence: 3,
      p_after: null,
      p_limit: 100
    });
    expect(page).toEqual({
      entries: [
        {
          fileId: A,
          name: 'polo-white.png',
          size: 1200,
          mime: 'image/png',
          classification: classifyCatalogImageName('polo-white.png'),
          source: { kind: 'space', materialId: A, contentId: CONTENT, size: 1200 }
        },
        {
          fileId: B,
          name: 'shirt.png',
          size: 1200,
          mime: 'image/png',
          classification: classifyCatalogImageName('shirt.png'),
          source: { kind: 'space', materialId: B, contentId: CONTENT, size: 1200 }
        }
      ],
      cursor: [{ kind: 'space-after', id: B }],
      complete: true,
      more: false
    });
  });

  it('continues after its cursor and stops at the import limit', async () => {
    const rpc = vi.fn(async () => ({ items: [item(A, 'a.png'), item(B, 'b.png')], hasMore: true }));
    const sources = createCatalogImageSpaceSources({ rpc, space: null });
    const page = await sources.enumerateSpace(
      claim({ cursor: [{ kind: 'space-after', id: SOURCE }], admittedCount: 999 }),
      'worker-1',
      new AbortController().signal
    );
    expect(rpc).toHaveBeenCalledWith(
      'service_catalog_image_space_enumerate',
      expect.objectContaining({ p_after: SOURCE })
    );
    expect(page.entries).toHaveLength(1);
    expect(page).toMatchObject({
      cursor: [{ kind: 'space-after', id: A }],
      complete: true,
      more: true
    });
    const unfinished = await createCatalogImageSpaceSources({
      rpc: vi.fn(async () => ({ items: [item(A, 'a.png')], hasMore: true })),
      space: null
    }).enumerateSpace(claim(), 'worker-1', new AbortController().signal);
    expect(unfinished).toMatchObject({ complete: false, more: false });
  });

  it('refuses a picture over the import size', async () => {
    const sources = createCatalogImageSpaceSources({
      rpc: vi.fn(async () => ({ items: [item(A, 'huge.png', 60_000_000)], hasMore: false })),
      space: null
    });
    await expect(
      sources.enumerateSpace(claim(), 'worker-1', new AbortController().signal)
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });

  it('reads a staged picture from its object while its file holds the same content', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const open = vi.fn(async () => ({
      size: 4,
      etag: '"e"',
      contentType: 'image/png',
      body: new Response(bytes).body
    }));
    const rpc = vi.fn(async () => ({ key: `t/${TEAM}/o/${CONTENT}`, size: 4 }));
    const sources = createCatalogImageSpaceSources({ rpc, space: { open } });
    const source = { kind: 'space', materialId: A, contentId: CONTENT, size: 4 };
    expect([
      ...(await sources.readSpace(source, ACTOR, TEAM, new AbortController().signal))
    ]).toEqual([1, 2, 3, 4]);
    expect(rpc).toHaveBeenCalledWith('service_catalog_image_space_source', {
      p_team: TEAM,
      p_actor: ACTOR,
      p_material: A,
      p_content: CONTENT
    });
    expect(open).toHaveBeenCalledWith(
      `t/${TEAM}/o/${CONTENT}`,
      { method: 'GET' },
      expect.any(AbortSignal)
    );

    const moved = createCatalogImageSpaceSources({
      rpc: vi.fn(async () => ({ key: `t/${TEAM}/o/${'e'.repeat(64)}`, size: 4 })),
      space: { open }
    });
    await expect(
      moved.readSpace(source, ACTOR, TEAM, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'IMAGE_SOURCE_CHANGED'
    });
    await expect(
      createCatalogImageSpaceSources({ rpc, space: null }).readSpace(
        source,
        ACTOR,
        TEAM,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('has the worker enumerate a space job from the space and a Drive job from Drive', async () => {
    const run = async (sourceKind: 'space' | 'drive') => {
      const enumerated = { entries: [], cursor: [], complete: true, more: false };
      const rpc = vi.fn<CatalogImageWorkerDeps['service']['rpc']>(async name => {
        if (name === 'service_catalog_image_purge_claim_v2') return { data: null, error: null };
        if (name === 'service_catalog_image_claim_v2')
          return { data: claim({ sourceKind }), error: null };
        return { data: true, error: null };
      });
      const deps: CatalogImageWorkerDeps = {
        service: { rpc },
        r2: {} as CatalogImageWorkerDeps['r2'],
        enabled: true,
        readDrive: vi.fn(),
        enumerateDrive: vi.fn(async () => enumerated),
        enumerateSpace: vi.fn(async () => enumerated)
      };
      await runCatalogImageWorker(deps);
      return deps;
    };
    const space = await run('space');
    expect(space.enumerateSpace).toHaveBeenCalledOnce();
    expect(space.enumerateDrive).not.toHaveBeenCalled();
    const drive = await run('drive');
    expect(drive.enumerateDrive).toHaveBeenCalledOnce();
    expect(drive.enumerateSpace).not.toHaveBeenCalled();
  });
});
