import { expect, it, vi } from 'vitest';
import {
  isPublicationLaneRequest,
  PUBLICATION_LANE_BUDGET_MS,
  runCatalogPublicationLane,
  runPublicationPasses
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

it('chains passes while a due link is still moving, so it is published in one call (1.4.3 next)', async () => {
  // next: due 08:44:00, job at 08:44:10, dispatch at 08:44:29, verified 08:44:38 — three ticks.
  const passes = [
    {
      enabled: true,
      prepared: 0,
      claimed: 1,
      verified: 0,
      preserved: 0,
      waiting: 1,
      blocked: 0,
      uncertain: 0
    },
    {
      enabled: true,
      prepared: 1,
      claimed: 0,
      verified: 0,
      preserved: 0,
      waiting: 0,
      blocked: 0,
      uncertain: 0
    },
    {
      enabled: true,
      prepared: 0,
      claimed: 1,
      verified: 1,
      preserved: 0,
      waiting: 0,
      blocked: 0,
      uncertain: 0
    }
  ];
  const pass = vi.fn(async () => passes.shift()!);
  const result = await runPublicationPasses(pass as never, () => 0);
  expect(pass).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ verified: 1 });
});

it('stops chaining when a pass settles everything, moves nothing, or the budget is spent', async () => {
  const settled = vi.fn(async () => ({
    enabled: true,
    prepared: 0,
    claimed: 1,
    verified: 1,
    preserved: 0,
    waiting: 0,
    blocked: 0,
    uncertain: 0
  }));
  await runPublicationPasses(settled as never, () => 0);
  expect(settled).toHaveBeenCalledTimes(1);
  const idle = vi.fn(async () => ({
    enabled: true,
    prepared: 0,
    claimed: 0,
    verified: 0,
    preserved: 0,
    waiting: 0,
    blocked: 0,
    uncertain: 0
  }));
  await runPublicationPasses(idle as never, () => 0);
  expect(idle).toHaveBeenCalledTimes(1);
  let now = 0;
  const slow = vi.fn(async () => {
    now += PUBLICATION_LANE_BUDGET_MS;
    return {
      enabled: true,
      prepared: 1,
      claimed: 0,
      verified: 0,
      preserved: 0,
      waiting: 0,
      blocked: 0,
      uncertain: 0
    };
  });
  await runPublicationPasses(slow as never, () => now);
  expect(slow).toHaveBeenCalledTimes(1);
});
