import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * 189: the one-hour due-validation window must not run out while the video set is
 * still being made; every "waiting" answer clears an undispatched window.
 */
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});
it('clears an undispatched validation window on every wait for the video set', async () => {
  const source = (
    await db.root<{ d: string }>(
      `select pg_get_functiondef('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure) d`
    )
  )[0]!.d;
  const waits = source.split("return jsonb_build_object('state','waiting');").length - 1;
  const resets =
    source.split(
      "set validation_epoch_started_at=null where id=j.id and dispatched_at is null;return jsonb_build_object('state','waiting');"
    ).length - 1;
  expect(waits).toBe(3);
  expect(resets).toBe(3);
  // The expiry itself stays for a ready set whose sources cannot be proven for an hour.
  expect(source).toContain("validation_epoch_started_at<clock_timestamp()-interval '1 hour'");
});
