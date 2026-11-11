import { expect, it, vi } from 'vitest';
import {
  isPublicationLaneRequest,
  runCatalogPublicationLane
} from '../supabase/functions/catalog-updater/publication-lane';

it('recognises only an explicit publication-lane request', () => {
  expect(isPublicationLaneRequest({ publicationsOnly: true })).toBe(true);
  for (const body of [null, {}, { scheduled: true }, { publicationsOnly: 'true' }, 'x'])
    expect(isPublicationLaneRequest(body)).toBe(false);
});

it('runs nothing but the publication scheduler, which marks due jobs unsupported without the writer', async () => {
  const rpc = vi.fn(async (name: string) => ({
    data: name === 'service_mark_due_catalog_publications_unsupported' ? 0 : null,
    error: null
  }));
  const result = await runCatalogPublicationLane(
    { rpc } as never,
    '78400000-0000-4000-8000-000000000001',
    // A beta without the CATALOG_NATIVE_SHEETS_BETA opt-in has no targeted writer.
    name => (name === 'SOTY_ENVIRONMENT' ? 'beta' : undefined)
  );
  expect(result).toMatchObject({ enabled: false, code: 'CATALOG_WRITE_UNSUPPORTED' });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_mark_due_catalog_publications_unsupported'
  ]);
});
