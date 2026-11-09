import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';

/**
 * Beta 2026-11-08: a due targeted-cells publication was dispatched, the write never
 * reached Google, and the job stayed `unknown` forever because readback could only say
 * "not verified". `absent` (no receipt marker of this fence) requeues the job only once
 * the provider request window has closed, by the server clock.
 */
let db: TeamTestDb;
const team = '78000000-0000-4000-8000-000000000001';
const actor = '78000000-0000-4000-8000-000000000002';
const worker = '78000000-0000-4000-8000-000000000003';

beforeAll(async () => {
  db = await createTeamTestDb();
}, 180_000);
afterAll(async () => {
  await db?.close();
});

async function dispatched(sinceSeconds: number) {
  const catalog = crypto.randomUUID(),
    job = crypto.randomUUID(),
    fence = crypto.randomUUID(),
    target = crypto.randomUUID();
  // The settle path is under test; claims, reservation and dispatch are covered elsewhere.
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      `insert into private.catalog_video_publication_policies
         (catalog_material_id, team_id, actor_id, revision, mode, legacy_delivery_unverified, target_id)
       values ($1, $2, $3, 1, 'immediate', false, $4)`,
      [catalog, team, actor, target]
    );
    await db.root(
      `insert into private.catalog_video_publication_jobs
         (id, catalog_material_id, team_id, revision, command_id, target_id, actor_id, state,
          worker_id, lease_until, writer_fence, dispatched_at, validation_epoch_started_at)
       values ($1, $2, $3, 1, gen_random_uuid(), $4, $5, 'applying', $6,
               clock_timestamp() + interval '1 minute', $7,
               clock_timestamp() - make_interval(secs => $8), clock_timestamp() - interval '2 hours')`,
      [job, catalog, team, target, actor, worker, fence, sinceSeconds]
    );
    await db.root(
      `insert into private.catalog_update_reconciliations
         (catalog_material_id, marker, expected_count, product_count, settings_snapshot,
          publication_job_id, publication_revision)
       values ($1, $2, 0, 3, '{}', $3, 1)`,
      [catalog, fence, job]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { job, fence, catalog };
}
const settle = (job: string, fence: string, outcome: string) =>
  db.root<{ ok: boolean }>(
    'select public.service_settle_catalog_publication($1,$2,$3,$4,null) ok',
    [job, worker, fence, outcome]
  );
const state = async (job: string) =>
  (
    await db.root<{
      state: string;
      writer_fence: string | null;
      dispatched_at: string | null;
      validation_epoch_started_at: string | null;
    }>(
      `select state, writer_fence, dispatched_at, validation_epoch_started_at
       from private.catalog_video_publication_jobs where id = $1`,
      [job]
    )
  )[0]!;
const reconciliations = async (catalog: string) =>
  (
    await db.root<{ n: number }>(
      'select count(*)::int n from private.catalog_update_reconciliations where catalog_material_id = $1',
      [catalog]
    )
  )[0]!.n;

it('keeps a fresh absent write unknown: the request may still land', async () => {
  const { job, fence, catalog } = await dispatched(30);
  await settle(job, fence, 'absent');
  expect(await state(job)).toMatchObject({ state: 'unknown', writer_fence: fence });
  expect(await reconciliations(catalog)).toBe(1);
});

it('requeues an absent write after the request window, with a fresh fence and epoch', async () => {
  const { job, fence, catalog } = await dispatched(180);
  await settle(job, fence, 'absent');
  expect(await state(job)).toEqual({
    state: 'retry_wait',
    writer_fence: null,
    dispatched_at: null,
    validation_epoch_started_at: null
  });
  expect(await reconciliations(catalog)).toBe(0);
});

it('never requeues on plain unknown, and still refuses a foreign fence', async () => {
  const { job, fence } = await dispatched(3600);
  await settle(job, fence, 'unknown');
  expect(await state(job)).toMatchObject({ state: 'unknown', writer_fence: fence });
  await expect(settle(job, crypto.randomUUID(), 'absent')).rejects.toThrow(
    'PROCESS_RESULT_UNCERTAIN'
  );
  expect(await state(job)).toMatchObject({ state: 'unknown', writer_fence: fence });
});
