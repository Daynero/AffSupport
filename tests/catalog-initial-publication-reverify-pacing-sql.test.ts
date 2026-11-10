import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.2 paced re-verification inside service_begin_initial_catalog_publication,
 * so any exception there rolled the pacing back and the same intents were
 * relisted every minute, holding every recovery slot. A catalog registered with
 * no publication policy was never listed at all, and the no-restitch refresh
 * refused every registered intent. 194000 fixes all three.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
const def = async (signature: string) =>
  (await db.root<{ d: string }>(`select pg_get_functiondef('${signature}'::regprocedure) d`))[0]!.d;

it('claims each re-verification in its own transaction, five minutes apart, at most twelve times', async () => {
  const claim = await def('public.service_claim_initial_publication_reverify(uuid,uuid,uuid)');
  expect(claim).toContain("if r.retry_after>clock_timestamp() then return 'paced';end if;");
  expect(claim).toContain('if r.attempts>=12 then');
  expect(claim).toContain(
    "set attempts=attempts+1,retry_after=clock_timestamp()+interval '5 minutes'"
  );
  const grants = await db.root<{ grantee: string }>(
    `select grantee from information_schema.routine_privileges where routine_name='service_claim_initial_publication_reverify'`
  );
  expect(grants.map(g => g.grantee)).not.toContain('authenticated');
});

it('lists genuine recovery first and registered intents only while owed, unpaced and not exhausted', async () => {
  const listing = await def('public.service_list_initial_catalog_recovery(integer)');
  expect(listing).toContain("order by (i.state='registered'),i.next_attempt_at,i.id limit p_limit");
  expect(listing).toContain('(r.exhausted_at is not null or r.retry_after>statement_timestamp())');
  const owed = await def(
    'private.initial_publication_reverify_owed(private.catalog_generation_intents)'
  );
  // A registered catalog with no check and no policy at all is owed its publication.
  expect(owed).toContain(
    "not exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id::text=i.checkpoint->>'materialId')"
  );
});

it('lets a registered no-restitch catalog refresh its original until the check is verified', async () => {
  const capture = await def(
    'public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)'
  );
  expect(capture).not.toContain("state not in('canceled','registered')");
  expect(capture).toContain(
    "(state<>'registered' or not exists(select 1 from private.catalog_initial_publication_checks verified where verified.intent_id=p_intent and verified.state='verified'))"
  );
});
