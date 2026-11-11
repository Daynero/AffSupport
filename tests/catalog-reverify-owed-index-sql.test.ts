import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: the per-minute recovery listing checked "no policy for this catalog"
 * with a text comparison that scanned every publication policy each time.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
it('looks up the publication policy by its uuid key', async () => {
  const source = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('private.initial_publication_reverify_owed(private.catalog_generation_intents)'::regprocedure) d`
    )
  )[0]!.d;
  expect(source).toContain("p.catalog_material_id=(i.checkpoint->>'materialId')::uuid");
  expect(source).not.toContain('catalog_material_id::text');
});
