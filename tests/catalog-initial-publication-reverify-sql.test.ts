import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.2: a catalog registered while its first publication verification was
 * still open stayed blocked (legacy_adoption_required) forever, because nothing
 * listed it for recovery again. The listing now returns such registered
 * intents, paced by retry_after, which the verification's begin step advances.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
it('lists registered intents with an open initial check and paces their retries', async () => {
  const listing = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('public.service_list_initial_catalog_recovery(integer)'::regprocedure) d`
    )
  )[0]!.d;
  // 194000 moved the registered branch behind a committed pacing claim.
  expect(listing).toContain('private.initial_publication_reverify_owed(i)');
  // The interrupted branch is unchanged.
  expect(listing).toContain(
    "(i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp()"
  );
  const begin = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('public.service_begin_initial_catalog_publication(uuid,uuid,uuid,uuid)'::regprocedure) d`
    )
  )[0]!.d;
  expect(begin).toContain(
    "update private.catalog_initial_publication_checks set retry_after=statement_timestamp()+interval '5 minutes' where intent_id=b.intent_id;"
  );
  const column = await db.root<{ column_default: string; is_nullable: string }>(
    `select column_default, is_nullable from information_schema.columns where table_schema='private' and table_name='catalog_initial_publication_checks' and column_name='retry_after'`
  );
  expect(column).toHaveLength(1);
  expect(column[0]!.is_nullable).toBe('NO');
});
