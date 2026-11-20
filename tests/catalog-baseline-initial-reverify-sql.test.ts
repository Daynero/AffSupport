import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: "Перевірити чинні посилання" on a catalog whose creation-time check is
 * still open could only fail (its reconciliation row made begin refuse, and a
 * restitched catalog's cells hold variants, not the original). The baseline now
 * hands the catalog to the server's own re-verification and makes it due now.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});

it('defers to the initial re-verification before any baseline bookkeeping', async () => {
  const definition = async (name: string) =>
    (
      await db.root<{ d: string }>(
        `select pg_get_functiondef('public.${name}(uuid,uuid,uuid,uuid,bigint)'::regprocedure) d`
      )
    )[0]!.d;
  // 062 wraps the public entry point: a catalog of several creatives or of images is
  // refused first, every other catalog goes on to the unchanged body below.
  const wrapper = await definition('service_begin_catalog_baseline_check');
  expect(wrapper).toContain('MULTI_CREATIVE_UNSUPPORTED');
  expect(wrapper).toContain('service_begin_catalog_baseline_check_before_062(');
  const begin = await definition('service_begin_catalog_baseline_check_before_062');
  const branch = begin.indexOf(
    "if exists(select 1 from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.team_id=p_team and ic.state='reading') then"
  );
  expect(branch).toBeGreaterThan(0);
  expect(begin).toContain("return jsonb_build_object('state','initial_reverify');");
  // The re-verification becomes due at once, and an exhausted one gets one more try.
  expect(begin).toContain(
    "on conflict(intent_id) do update set retry_after='-infinity',exhausted_at=null,attempts=least(private.catalog_initial_publication_reverify.attempts,11)"
  );
  // No baseline row and no reconciliation row is written on this path.
  expect(branch).toBeLessThan(
    begin.indexOf('insert into private.catalog_publication_baseline_checks')
  );
  expect(branch).toBeLessThan(begin.indexOf("raise exception 'PROCESS_RESULT_UNCERTAIN'"));
});
