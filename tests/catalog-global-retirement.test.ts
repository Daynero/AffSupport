import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  globalTestDb,
  activateGlobalFixture,
  GLOBAL_OWNER,
  GLOBAL_IMAGE
} from './support/catalog-global-db.js';
import type { TeamTestDb } from './support/team-db.js';
let db: TeamTestDb, team: string;
beforeAll(async () => {
  ({ db, team } = await globalTestDb());
  await db.asUser(GLOBAL_OWNER, 'select public.set_team_product_catalog_settings($1,$2)', [
    team,
    JSON.stringify({
      title: 'Generic',
      description: 'Item',
      priceMin: 10,
      priceMax: 20,
      imageLink: 'https://external.example.test/preserved.jpg'
    })
  ]);
}, 60_000);
afterAll(async () => {
  await db?.close();
});
it('retains external references until the immutable deadline and unlinks only metadata at it', async () => {
  await activateGlobalFixture(db);
  expect(
    (
      await db.root<{ value: { retained: boolean } }>(
        'select public.service_catalog_global_retirement_tick() value'
      )
    )[0]!.value
  ).toEqual({ retained: true });
  const [before] = await db.root<{ image_link: string }>(
    'select image_link from public.team_product_catalog_settings where team_id=$1',
    [team]
  );
  expect(before!.image_link).toContain('preserved');
  // Owned disposable clock fixture, no production clock/backdating. Temporarily bypass only
  // the immutable trigger to create an already-due policy baseline in this isolated database.
  await db.root(
    'alter table private.catalog_global_policy disable trigger catalog_global_policy_immutable'
  );
  await db.root(
    "update private.catalog_global_policy set activated_at=t.baseline_time,delete_after=t.baseline_time+interval '720 hours' from(select clock_timestamp()-interval '721 hours' as baseline_time)t"
  );
  await db.root(
    'alter table private.catalog_global_policy enable trigger catalog_global_policy_immutable'
  );
  await db.root(
    'update private.catalog_image_retirements set delete_after=(select delete_after from private.catalog_global_policy)'
  );
  await db.root('select public.service_catalog_global_retirement_tick()');
  const [after] = await db.root<{ image_link: null; title: string; price_min: number }>(
    'select image_link,title,price_min from public.team_product_catalog_settings where team_id=$1',
    [team]
  );
  expect(after).toEqual({ image_link: null, title: 'Generic', price_min: 10 });
  const [policy] = await db.root<{ state: string }>(
    'select state from private.catalog_global_policy'
  );
  expect(policy!.state).toBe('cleanup_complete');
  const [target] = await db.root<{ kind: string; state: string }>(
    'select kind,state from private.catalog_image_retirements'
  );
  expect(target).toEqual({ kind: 'metadata_unlink', state: 'metadata_unlinked' });
  const [protectedImage] = await db.root<{ state: string }>(
    'select state from private.catalog_global_images where id=$1',
    [GLOBAL_IMAGE]
  );
  expect(protectedImage!.state).toBe('ready');
});
it('holds physical v1 deletion through team removal and credits only the confirmed purge once', async () => {
  const fixture = await globalTestDb();
  const d = fixture.db,
    t = fixture.team;
  try {
    const [publication] = await d.root<{ id: string; object_key: string }>(
      `insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state)
   values($1,repeat('e',64),1000,'image/jpeg',500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','ready') returning id,object_key`,
      [t]
    );
    await activateGlobalFixture(d);
    await d.root(
      "insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason) values($1,$2,'public',$3,'explicit_revoke')",
      [publication!.id, t, publication!.object_key]
    );
    expect(
      (
        await d.root<{ value: null }>('select public.service_catalog_image_purge_claim_v2() value')
      )[0]!.value
    ).toBeNull();
    await d.root('delete from public.teams where id=$1', [t]);
    const [hold] = await d.root<{ held: boolean; charged: boolean }>(
      `select q.not_before>clock_timestamp() held,s.charged from private.catalog_image_purges q join private.catalog_image_storage s on s.publication_id=q.publication_id where q.object_key=$1`,
      [publication!.object_key]
    );
    expect(hold).toEqual({ held: true, charged: true });
    await d.root(
      'alter table private.catalog_global_policy disable trigger catalog_global_policy_immutable'
    );
    await d.root(
      "update private.catalog_global_policy set activated_at=x.baseline_time,delete_after=x.baseline_time+interval '720 hours' from(select clock_timestamp()-interval '721 hours' as baseline_time)x"
    );
    await d.root(
      'alter table private.catalog_global_policy enable trigger catalog_global_policy_immutable'
    );
    await d.root(
      'update private.catalog_image_retirements set delete_after=(select delete_after from private.catalog_global_policy)'
    );
    await d.root(
      'update private.catalog_image_purges set not_before=(select delete_after from private.catalog_global_policy) where object_key=$1',
      [publication!.object_key]
    );
    await d.root('select public.service_catalog_global_retirement_tick()');
    const claim = (
      await d.root<{ value: { id: string; fence: number; key: string } }>(
        'select public.service_catalog_image_purge_claim_v2() value'
      )
    )[0]!.value;
    expect(claim.key).toBe(publication!.object_key);
    await d.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
      claim.id,
      claim.fence
    ]);
    await expect(
      d.root('select public.service_catalog_image_purge_finish_v2($1,$2,true)', [
        claim.id,
        claim.fence
      ])
    ).rejects.toThrow('LEASE_MISMATCH');
    expect(
      (
        await d.root<{ charged: boolean }>(
          'select charged from private.catalog_image_storage where publication_id=$1',
          [publication!.id]
        )
      )[0]!.charged
    ).toBe(false);
    await d.root(
      'update private.catalog_image_retirements set next_attempt_at=clock_timestamp() where object_key=$1',
      [publication!.object_key]
    );
    await d.root('select public.service_catalog_global_retirement_tick()');
    expect(
      (
        await d.root<{ state: string }>(
          'select state from private.catalog_image_retirements where object_key=$1',
          [publication!.object_key]
        )
      )[0]!.state
    ).toBe('verified_deleted');
  } finally {
    await d.close();
  }
});
it('captures managed tombstones whose team was already deleted before T0', async () => {
  const fixture = await globalTestDb();
  const d = fixture.db,
    t = fixture.team;
  try {
    const [p] = await d.root<{ id: string; object_key: string }>(
      `insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,state) values($1,repeat('f',64),1000,'image/jpeg',500,500,'{"mode":"unclassified","garment":null,"color":null,"reason":"unknown","vocabularyVersion":"catalog-clothing-v1"}','ready') returning id,object_key`,
      [t]
    );
    await d.root('delete from public.teams where id=$1', [t]);
    await activateGlobalFixture(d);
    const [target] = await d.root<{ object_key: string; held: boolean }>(
      'select object_key,delete_after>clock_timestamp() held from private.catalog_image_retirements where publication_id=$1',
      [p!.id]
    );
    expect(target).toEqual({ object_key: p!.object_key, held: true });
    expect(
      (
        await d.root<{ held: boolean }>(
          'select not_before>clock_timestamp() held from private.catalog_image_purges where publication_id=$1',
          [p!.id]
        )
      )[0]!.held
    ).toBe(true);
  } finally {
    await d.close();
  }
});
