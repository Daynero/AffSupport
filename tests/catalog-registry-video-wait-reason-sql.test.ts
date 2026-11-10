import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 1.4.2: a restitch update round that waits for an agent (AGENT_REQUIRED) must
 * say so in the manager row instead of a bare "0 of N".
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
it('carries the waiting round reason in the registry video progress', async () => {
  const source = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('private.catalog_registry_video_generation(uuid,uuid)'::regprocedure) d`
    )
  )[0]!.d;
  expect(source).toContain("'waitReason',reason");
  expect(source).toContain('coalesce(n0.failure_code,a.failure_code) into reason');
  // A ready set never reports a stale reason.
  expect(source).toContain("if st<>'ready' then");
});
