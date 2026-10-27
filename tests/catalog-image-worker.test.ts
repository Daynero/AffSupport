import { describe, expect, it, vi } from 'vitest';
import { classifyCatalogImageName } from '../packages/shared/src/team/catalog-images';
import {
  runCatalogImageWorker,
  type CatalogImageWorkerDeps
} from '../supabase/functions/catalog-images/worker';
import { CatalogImageR2 } from '../supabase/functions/_shared/r2-catalog-images';
import { validateCatalogImage } from '../supabase/functions/_shared/catalog-image-validation';

const ENTRY = '45000000-0000-4000-8000-000000000801';
const JOB = '45000000-0000-4000-8000-000000000802';
const TEAM = '45000000-0000-4000-8000-000000000803';
const ACTOR = '45000000-0000-4000-8000-000000000804';
const PUBLICATION = '45000000-0000-4000-8000-000000000805';
const STAGING = '45000000-0000-4000-8000-000000000806';
const KEY = `v1/${PUBLICATION}`;
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  )
);
const config = {
  accountId: 'a'.repeat(32),
  stagingBucket: 'staging',
  publicBucket: 'public',
  publicOrigin: 'https://media.test',
  zoneId: 'b'.repeat(32),
  purgeToken: 'not-a-real-token'
};

async function fixture(
  options: {
    put?: 'normal' | 'exists' | 'lost';
    originMismatch?: boolean;
    publicMismatch?: boolean;
    overwriteStagingAfterReservation?: boolean;
    commitFailure?: boolean;
  } = {}
) {
  const image = await validateCatalogImage(PNG, 'image/png');
  const candidate = {
    id: PUBLICATION,
    key: KEY,
    fence: 4,
    ready: false,
    sha256: image.sha256,
    size: image.size,
    mime: image.mime
  };
  const trace: string[] = [];
  const store = {
    stage: PNG.slice(),
    origin: options.put === 'exists' ? PNG.slice() : (null as Uint8Array | null),
    entryState: 'staged',
    publicationState: 'candidate',
    persistedCandidate: null as string | null,
    committed: false
  };
  if (options.originMismatch && store.origin) store.origin[store.origin.length - 1] ^= 1;
  const rpc = vi.fn<CatalogImageWorkerDeps['service']['rpc']>(async (name, params) => {
    trace.push(`rpc:${name}:${String(params.p_state ?? params.p_stage ?? '')}`);
    if (name === 'service_catalog_image_purge_claim_v2') return { data: null, error: null };
    if (name === 'service_catalog_image_claim_v2')
      return {
        data: {
          kind: 'file',
          id: ENTRY,
          jobId: JOB,
          teamId: TEAM,
          actorId: ACTOR,
          fence: 7,
          state: store.entryState,
          source: {},
          stagingKey: STAGING,
          size: PNG.length,
          mime: 'image/png',
          classification: classifyCatalogImageName('IMG_2031.png')
        },
        error: null
      };
    if (name === 'service_catalog_image_reserve_v2') {
      expect(params.p_image).toMatchObject({ sha256: image.sha256, size: PNG.length });
      store.persistedCandidate = candidate.id;
      if (options.overwriteStagingAfterReservation) store.stage.fill(0);
      return { data: candidate, error: null };
    }
    if (name === 'service_catalog_image_candidate_v2') return { data: candidate, error: null };
    if (name === 'service_catalog_image_publication_v2')
      store.publicationState = String(params.p_state);
    if (name === 'service_catalog_image_commit_v2') {
      if (options.commitFailure)
        return { data: null, error: { message: 'IMAGE_DICTIONARY_COMMIT_FAILED' } };
      store.committed = true;
      store.entryState = 'ready';
    }
    if (name === 'service_catalog_image_release_v2')
      store.entryState = params.p_unknown ? 'awaiting_reconciliation' : 'failed';
    return { data: true, error: null };
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const publicRead = url.origin === config.publicOrigin;
    const kind = publicRead ? 'cdn' : url.pathname.startsWith('/staging/') ? 'staging' : 'origin';
    trace.push(`fetch:${request.method}:${kind}`);
    if (request.method === 'PUT') {
      // Both durable candidate identity and the uncertain-write marker must
      // exist before any provider can accept the final bytes.
      expect(store.persistedCandidate).toBe(PUBLICATION);
      expect(store.publicationState).toBe('put_unknown');
      expect(request.headers.get('if-none-match')).toBe('*');
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(PNG);
      if (options.put === 'lost') throw new TypeError('Response lost');
      if (options.put === 'exists') return new Response(null, { status: 412 });
      store.origin = PNG.slice();
      return new Response(null, { status: 200 });
    }
    if (request.method !== 'GET') throw new Error('Unexpected provider operation');
    const bytes = kind === 'staging' ? store.stage : store.origin;
    if (!bytes) return new Response(null, { status: 404 });
    const response = bytes.slice();
    if (publicRead && options.publicMismatch) response[response.length - 1] ^= 1;
    return new Response(response, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(response.length),
        'x-content-type-options': 'nosniff'
      }
    });
  });
  const r2 = new CatalogImageR2(config, { sign: async request => request }, fetcher);
  const deps: CatalogImageWorkerDeps = {
    service: { rpc },
    r2,
    enabled: true,
    readDrive: async () => {
      throw new Error('Local import must not read Drive');
    },
    enumerateDrive: async () => {
      throw new Error('File claim must not enumerate');
    }
  };
  return { deps, rpc, fetcher, store, trace };
}
const calls = (f: Awaited<ReturnType<typeof fixture>>, name: string) =>
  f.rpc.mock.calls.filter(([method]) => method === name);

describe('catalog image worker publication receipts and recovery', () => {
  it('persists candidate before PUT and publishes the verified buffer despite a later staging overwrite', async () => {
    const f = await fixture({ overwriteStagingAfterReservation: true });
    expect(await runCatalogImageWorker(f.deps)).toMatchObject({ outcome: 'ready' });
    expect(f.store.stage).not.toEqual(PNG);
    expect(f.store.origin).toEqual(PNG);
    expect(f.trace.indexOf('fetch:PUT:origin')).toBeGreaterThan(
      f.trace.indexOf('rpc:service_catalog_image_reserve_v2:')
    );
    expect(f.trace.indexOf('fetch:PUT:origin')).toBeGreaterThan(
      f.trace.indexOf('rpc:service_catalog_image_publication_v2:put_unknown')
    );
    expect(f.trace.filter(item => item === 'fetch:GET:staging')).toHaveLength(1);
    expect(calls(f, 'service_catalog_image_commit_v2')).toHaveLength(1);
    expect(f.store.committed).toBe(true);
  });

  it.each([false, true])(
    'checks existing-object bytes after 412 before reporting ready (mismatch=%s)',
    async mismatch => {
      const f = await fixture({ put: 'exists', originMismatch: mismatch });
      const result = await runCatalogImageWorker(f.deps);
      expect(result).toMatchObject(
        mismatch
          ? { outcome: 'failed', code: 'IMAGE_PUBLIC_VERIFICATION_FAILED' }
          : { outcome: 'ready' }
      );
      expect(f.trace).toContain('fetch:GET:origin');
      expect(calls(f, 'service_catalog_image_commit_v2')).toHaveLength(mismatch ? 0 : 1);
      expect(f.store.committed).toBe(!mismatch);
      if (!mismatch) {
        expect(f.trace).toContain('fetch:GET:cdn');
        expect(f.trace.indexOf('rpc:service_catalog_image_commit_v2:')).toBeGreaterThan(
          f.trace.indexOf('fetch:GET:cdn')
        );
      }
    }
  );

  it('keeps the same unknown publication after a lost PUT response and negative origin read, without another PUT', async () => {
    const f = await fixture({ put: 'lost' });
    expect(await runCatalogImageWorker(f.deps)).toMatchObject({
      outcome: 'unknown',
      code: 'IMAGE_WRITE_UNCERTAIN'
    });
    expect(f.store.entryState).toBe('awaiting_reconciliation');
    expect(f.store.persistedCandidate).toBe(PUBLICATION);
    expect(await runCatalogImageWorker(f.deps)).toMatchObject({ outcome: 'unknown' });
    expect(calls(f, 'service_catalog_image_reserve_v2')).toHaveLength(1);
    expect(calls(f, 'service_catalog_image_candidate_v2')).toHaveLength(1);
    expect(f.trace.filter(item => item === 'fetch:PUT:origin')).toHaveLength(1);
    expect(calls(f, 'service_catalog_image_commit_v2')).toHaveLength(0);
    expect(
      calls(f, 'service_catalog_image_release_v2').every(([, params]) => params.p_unknown === true)
    ).toBe(true);
    expect(f.store.entryState).toBe('awaiting_reconciliation');
    expect(f.store.committed).toBe(false);
  });

  it('refuses dictionary commit when the anonymous public readback differs', async () => {
    const f = await fixture({ publicMismatch: true });
    expect(await runCatalogImageWorker(f.deps)).toMatchObject({
      outcome: 'failed',
      code: 'IMAGE_PUBLIC_VERIFICATION_FAILED'
    });
    expect(f.trace).toContain('fetch:GET:origin');
    expect(f.trace).toContain('fetch:GET:cdn');
    expect(calls(f, 'service_catalog_image_commit_v2')).toHaveLength(0);
    expect(f.store.committed).toBe(false);
  });

  it('does not report ready when the dictionary commit fails after successful public verification', async () => {
    const f = await fixture({ commitFailure: true });
    expect(await runCatalogImageWorker(f.deps)).toMatchObject({
      outcome: 'failed',
      code: 'IMAGE_DICTIONARY_COMMIT_FAILED'
    });
    expect(f.store.publicationState).toBe('public_verified');
    expect(calls(f, 'service_catalog_image_commit_v2')).toHaveLength(1);
    expect(calls(f, 'service_catalog_image_release_v2').at(-1)?.[1]).toMatchObject({
      p_code: 'IMAGE_DICTIONARY_COMMIT_FAILED'
    });
    expect(f.store.committed).toBe(false);
  });

  it('refuses a concurrent invocation before even claiming work in a busy isolate', async () => {
    const f = await fixture();
    let unblock = () => {};
    let entered = () => {};
    const waiting = new Promise<void>(resolve => {
      unblock = resolve;
    });
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const firstRpc = vi.fn<CatalogImageWorkerDeps['service']['rpc']>(async name => {
      if (name === 'service_catalog_image_purge_claim_v2') {
        entered();
        await waiting;
      }
      return { data: null, error: null };
    });
    const first = runCatalogImageWorker({ ...f.deps, service: { rpc: firstRpc } });
    try {
      await started;
      expect(await runCatalogImageWorker(f.deps)).toEqual({ busy: true, retryAfterSeconds: 5 });
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      unblock();
      expect(await first).toEqual({ idle: true });
    }
  });
});
