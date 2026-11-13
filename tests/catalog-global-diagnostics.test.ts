import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  globalTestDb,
  GLOBAL_IMAGE,
  GLOBAL_OWNER,
  GLOBAL_OTHER
} from './support/catalog-global-db.js';
import type { TeamTestDb } from './support/team-db.js';
import { setQueryExecutor } from '../scripts/analytics/db.js';
import { resolvePeriod } from '../scripts/analytics/periods.js';
import {
  getGlobalImageStatus,
  getGlobalImageEvidence
} from '../scripts/analytics/global-images.js';
import { globalFixtureId } from './fixtures/catalog-global.js';
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
  setQueryExecutor((sql, params) => db.root(sql, params));
}, 60_000);
afterAll(async () => {
  setQueryExecutor(null);
  await db?.close();
});
it('reports exact issued and confirmed counts with a nonblocking threshold', async () => {
  await db.root(
    'update private.catalog_global_images set issued_seq=5001,confirmed_uses=5000 where id=$1',
    [GLOBAL_IMAGE]
  );
  const data = await getGlobalImageStatus(resolvePeriod('all', undefined));
  expect(data).toMatchObject({
    supported: true,
    status: 'current_observation',
    threshold: 5000,
    threshold_blocks: false,
    summary: { issued_slots_total: '5001', confirmed_uses_total: '5000', images_at_least_5000: 1 }
  });
  const history = await getGlobalImageStatus(
    resolvePeriod('all', undefined, new Date().toISOString())
  );
  expect(history).toMatchObject({ status: 'historical_unknown', summary: null, images: [] });
});
it('uses one read snapshot and refuses stale cursors after a status-visible tuple changes', async () => {
  const image = globalFixtureId(61000);
  await db.root(
    `insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification) values($1::uuid,'beta','g1/'||$1::text,repeat('b',64),'image/png',1000,500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}')`,
    [image]
  );
  const first = await getGlobalImageStatus(resolvePeriod('all', undefined), { limit: 1 });
  expect(first.next_cursor).toBeTypeOf('string');
  const next = await getGlobalImageStatus(resolvePeriod('all', undefined), {
    limit: 1,
    cursor: first.next_cursor!
  });
  expect(next).toMatchObject({ status: 'current_observation', truncated: false });
  await db.root('update private.catalog_global_images set issued_seq=issued_seq+1 where id=$1', [
    image
  ]);
  expect(
    await getGlobalImageStatus(resolvePeriod('all', undefined), {
      limit: 1,
      cursor: first.next_cursor!
    })
  ).toMatchObject({ status: 'cursor_stale', partial: true, images: [] });
});
it('keeps content and URL tokens out of evidence and makes missing correlation explicit', async () => {
  const flow = globalFixtureId(62000);
  await db.root(
    "insert into private.catalog_global_journal(flow_id,team_id,image_id,stage,counts) values($1,$2,$3,'allocated','{\"rows\":200}')",
    [flow, team, GLOBAL_IMAGE]
  );
  const diagnosis = await getGlobalImageEvidence(flow, resolvePeriod('all', undefined));
  expect(diagnosis).toMatchObject({ supported: true, last_proven_stage: 'allocated' });
  expect(JSON.stringify(diagnosis)).not.toMatch(
    /public_url|sha256|g1\/|fileKey|displayName|example.test/u
  );
  expect(
    (await getGlobalImageEvidence(GLOBAL_OWNER, resolvePeriod('all', undefined))).blind_spots
  ).not.toHaveLength(0);
});
it('carries a sanitized server stage into inspect and owned investigation evidence', async () => {
  const { sanitizeGlobalImageMetadata } =
    await import('../packages/shared/src/team/catalog-global-images.js');
  const { getInspect } = await import('../scripts/analytics/queries.js');
  const { getOwnedGlobalImageEvidence, getGlobalImageAudit } =
    await import('../scripts/analytics/global-images.js');
  const flow = globalFixtureId(66000);
  const safe = sanitizeGlobalImageMetadata({
    flowId: flow,
    stage: 'allocated',
    rows: 200,
    url: 'https://private.test/token',
    filename: 'private-name.jpg',
    secret: 'no'
  });
  expect(safe).toEqual({ flowId: flow, stage: 'allocated', rows: 200 });
  await db.root(
    "insert into private.catalog_global_journal(flow_id,actor_id,stage,counts) values($1,$2,'allocated','{\"rows\":200}')",
    [flow, GLOBAL_OWNER]
  );
  expect(await getInspect(flow)).toMatchObject({
    found: true,
    capability: 'team.catalog_global_images',
    last_proven_stage: 'allocated'
  });
  expect(
    (await getOwnedGlobalImageEvidence(GLOBAL_OWNER, resolvePeriod('all', undefined))).evidence
  ).not.toHaveLength(0);
  expect(await getGlobalImageAudit(resolvePeriod('all', undefined))).toMatchObject({
    supported: true,
    missing: ['global_image_delivery_unobserved']
  });
});

it('never infers a user owner from a shared global image ID', async () => {
  const { getInvestigation } = await import('../scripts/analytics/investigate.js');
  await db.root(
    "insert into private.catalog_global_journal(flow_id,actor_id,image_id,stage) values($1,$2,$3,'allocated'),($4,$5,$3,'allocated')",
    [globalFixtureId(67001), GLOBAL_OWNER, GLOBAL_IMAGE, globalFixtureId(67002), GLOBAL_OTHER]
  );
  await expect(getInvestigation(GLOBAL_IMAGE, resolvePeriod('all', undefined))).rejects.toThrow(
    'Nothing matches'
  );
});
