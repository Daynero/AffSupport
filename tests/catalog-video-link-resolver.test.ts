import { describe, expect, it, vi } from 'vitest';
import {
  createCatalogVideoLinkResolver,
  type CatalogVideoLinkDeps
} from '../supabase/functions/_shared/catalog-video-link';

const CATALOG = '50000000-0000-4000-8000-000000000101';
const SOURCE = '50000000-0000-4000-8000-000000000102';
const COPY = '50000000-0000-4000-8000-000000000103';
const KEY = 'v/' + 'a'.repeat(32) + '.mp4';
const DRIVE = 'https://drive.google.com/file/d/file-1/view?usp=sharing';

function harness(answer: unknown | Error) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe('service_catalog_video_r2_resolve');
    expect(args).toEqual({
      p_catalog: CATALOG,
      p_source_material: SOURCE,
      p_source_version: 'strict-v1:abc',
      p_size_bytes: 100_000_000,
      p_mime: 'video/mp4',
      p_md5: 'b'.repeat(32),
      p_job: null,
      p_team: null,
      p_assume_enabled: false
    });
    if (answer instanceof Error) return { data: null, error: answer };
    return { data: answer, error: null };
  });
  const kick = vi.fn(async () => {});
  const log = vi.fn();
  const drive = vi.fn(async () => DRIVE);
  const deps: CatalogVideoLinkDeps = { service: { rpc }, kick, log };
  const resolve = () =>
    createCatalogVideoLinkResolver(deps).resolve({
      scope: { catalogMaterialId: CATALOG },
      source: { materialId: SOURCE, sourceVersion: 'strict-v1:abc', sizeBytes: 100_000_000, mimeType: 'video/mp4', checksum: 'b'.repeat(32) },
      drive
    });
  return { resolve, rpc, kick, log, drive };
}

describe('catalog video link resolver', () => {
  it('leaves a catalog without the option on its own Drive path', async () => {
    const h = harness({ enabled: false });
    expect(await h.resolve()).toEqual({ kind: 'drive', url: DRIVE });
    expect(h.drive).toHaveBeenCalledTimes(1);
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('answers R2 for a ready copy without touching the Drive path', async () => {
    const h = harness({ enabled: true, url: `https://videos.test/${KEY}`, copyId: COPY, state: 'ready' });
    expect(await h.resolve()).toEqual({ kind: 'r2', url: `https://videos.test/${KEY}`, copyId: COPY });
    expect(h.drive).not.toHaveBeenCalled();
  });

  it('falls back to Drive and nudges the worker when the copy was just planned', async () => {
    const h = harness({ enabled: true, url: null, copyId: COPY, state: 'planned' });
    expect(await h.resolve()).toEqual({ kind: 'drive', url: DRIVE });
    expect(h.kick).toHaveBeenCalledTimes(1);
    const uploading = harness({ enabled: true, url: null, copyId: COPY, state: 'uploading', reason: 'VIDEO_R2_PROVIDER_UNAVAILABLE' });
    expect(await uploading.resolve()).toEqual({ kind: 'drive', url: DRIVE });
    expect(uploading.kick).not.toHaveBeenCalled();
  });

  it('never throws because R2 is unavailable and never prints provider prose', async () => {
    const h = harness(new Error('connection to https://db.internal/private failed VIDEO_R2_PROVIDER_UNAVAILABLE'));
    expect(await h.resolve()).toEqual({ kind: 'drive', url: DRIVE });
    expect(h.log).toHaveBeenCalledWith('[catalog-video-link] resolve failed, using Drive', 'VIDEO_R2_PROVIDER_UNAVAILABLE');
  });

  it('refuses a non-opaque or foreign URL and keeps Drive', async () => {
    for (const url of [
      `https://videos.test/${KEY}?token=1`,
      `https://videos.test/${KEY}#x`,
      'https://videos.test/team/alice/IN 40.mp4',
      `http://videos.test/${KEY}`
    ]) {
      const h = harness({ enabled: true, url, copyId: COPY, state: 'ready' });
      expect(await h.resolve()).toEqual({ kind: 'drive', url: DRIVE });
    }
    const wrongState = harness({ enabled: true, url: `https://videos.test/${KEY}`, copyId: COPY, state: 'verifying' });
    expect(await wrongState.resolve()).toEqual({ kind: 'drive', url: DRIVE });
  });

  it('returns a base URL with no fragment or query for the caller to vary', async () => {
    const h = harness({ enabled: true, url: `https://videos.test/${KEY}`, copyId: COPY, state: 'ready' });
    const link = await h.resolve();
    expect(link.url).not.toMatch(/[?#]/u);
  });

  it('rejects malformed identities before any call', async () => {
    const rpc = vi.fn();
    await expect(
      createCatalogVideoLinkResolver({ service: { rpc } }).resolve({
        scope: { catalogMaterialId: 'catalog' },
        source: { materialId: SOURCE, sourceVersion: 'v', sizeBytes: 1, mimeType: 'video/mp4', checksum: null },
        drive: async () => DRIVE
      })
    ).rejects.toThrow(/INVALID_INPUT/u);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('scopes by publication job or by a catalog being created, and skips the call without the option', async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: true, url: `https://videos.test/${KEY}`, copyId: COPY, state: 'ready' }, error: null }));
    const source = { materialId: SOURCE, sourceVersion: 'strict-v1:abc', sizeBytes: 1, mimeType: 'video/mp4', checksum: null };
    const resolver = createCatalogVideoLinkResolver({ service: { rpc } });
    expect(await resolver.resolve({ scope: { publicationJobId: CATALOG }, source, drive: async () => DRIVE })).toMatchObject({ kind: 'r2' });
    expect(rpc).toHaveBeenLastCalledWith('service_catalog_video_r2_resolve', expect.objectContaining({ p_catalog: null, p_job: CATALOG, p_team: null }));
    expect(await resolver.resolve({ scope: { teamId: CATALOG, assumeEnabled: true }, source, drive: async () => DRIVE })).toMatchObject({ kind: 'r2' });
    expect(rpc).toHaveBeenLastCalledWith('service_catalog_video_r2_resolve', expect.objectContaining({ p_catalog: null, p_job: null, p_team: CATALOG, p_assume_enabled: true }));
    rpc.mockClear();
    expect(await resolver.resolve({ scope: { teamId: CATALOG, assumeEnabled: false }, source, drive: async () => DRIVE })).toEqual({ kind: 'drive', url: DRIVE });
    expect(rpc).not.toHaveBeenCalled();
  });
});
