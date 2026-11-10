import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.2: a catalog whose create-time publication verification never finished
 * (its initial check still 'reading') kept a reconciliation row that made the
 * dialog's "verify existing links" refuse forever, so the
 * legacy_adoption_required hold could never be released by the person.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
it('lets the baseline check pass an open initial publication check and close it', async () => {
  const begin = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('public.service_begin_catalog_baseline_check(uuid,uuid,uuid,uuid,bigint)'::regprocedure) d`
    )
  )[0]!.d;
  expect(begin).toContain(
    "not exists(select 1 from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.state='reading' and ic.job_id=r.publication_job_id and ic.fence=r.marker)"
  );
  expect(begin).not.toContain(
    'or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then'
  );
  const finish = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure) d`
    )
  )[0]!.d;
  expect(finish).toContain(
    "update private.catalog_initial_publication_checks set state='verified',provider_revision=p_provider_revision,cells_digest=p_video_cells_digest,verified_at=clock_timestamp() where catalog_material_id=b.catalog_material_id and state='reading'"
  );
  expect(finish).toContain(
    'delete from private.catalog_update_reconciliations r using private.catalog_initial_publication_checks ic'
  );
});
