import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Production after 1.4.3: the per-minute catalog updater kept waking with nothing to do.
 * A publication job had sat in retry_wait for forty hours, and the due checks counted it
 * although the scheduler's claim never picks it up. The due checks now ask exactly what
 * the claim asks, and a job still undispatched a day after it was due is closed.
 */
let db: TeamTestDb, team: string, connection: string, offlineTeam: string, offline: string;
const owner = '74200000-0000-4000-8000-000000000001';
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'due-alignment@example.invalid' });
  await db.root('insert into public.admin_users(user_id) values($1)', [owner]);
  team = (await db.asUser<{ id: string }>(owner, "select id from public.create_team('Due')"))[0]!
    .id;
  const cred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('due','due@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','connected',now()) returning id",
      [team, cred]
    )
  )[0]!.id;
  // A second space whose Drive needs reconnecting: the claim never takes its jobs.
  offlineTeam = (
    await db.asUser<{ id: string }>(owner, "select id from public.create_team('Offline')")
  )[0]!.id;
  const offlineCred = (
    await db.root<{ id: string }>(
      "insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by) values('offline','offline@example.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id",
      [owner]
    )
  )[0]!.id;
  offline = (
    await db.root<{ id: string }>(
      "insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at) values($1,$2,'root','Root','my_drive','needs_reauth',now()) returning id",
      [offlineTeam, offlineCred]
    )
  )[0]!.id;
}, 180_000);
afterAll(async () => {
  await db?.close();
});

let seq = 0;
async function publication(input: {
  dueAgo: string;
  createdAgo?: string;
  nextIn?: string;
  connected?: boolean;
}) {
  const n = ++seq;
  const conn = input.connected === false ? offline : connection,
    space = input.connected === false ? offlineTeam : team;
  const catalog = (
    await db.root<{ id: string }>(
      "insert into public.team_materials(team_id,connection_id,drive_file_id,name,kind,category,mime_type,drive_version) values($1,$2,$3,$3,'file','other','application/vnd.google-apps.spreadsheet','v1') returning id",
      [space, conn, 'due-catalog' + n]
    )
  )[0]!.id;
  const job = crypto.randomUUID(),
    target = crypto.randomUUID();
  await db.root('set session_replication_role = replica');
  try {
    await db.root(
      `insert into private.catalog_video_publication_policies
         (catalog_material_id,team_id,actor_id,revision,mode,due_at,time_zone,legacy_delivery_unverified,target_id)
       values($1,$2,$3,1,'scheduled',clock_timestamp()-$4::interval,'Europe/Kyiv',false,$5)`,
      [catalog, space, owner, input.dueAgo, target]
    );
    await db.root(
      `insert into private.catalog_video_publication_jobs
         (id,catalog_material_id,team_id,revision,command_id,target_id,actor_id,state,next_attempt_at,created_at)
       values($1,$2,$3,1,gen_random_uuid(),$4,$5,'retry_wait',clock_timestamp()+$6::interval,clock_timestamp()-$7::interval)`,
      [
        job,
        catalog,
        space,
        target,
        owner,
        input.nextIn ?? '0 seconds',
        input.createdAgo ?? '1 minute'
      ]
    );
  } finally {
    await db.root('set session_replication_role = origin');
  }
  return { catalog, job };
}
const clear = () =>
  db.root(
    "update private.catalog_video_publication_jobs set state='published' where state<>'published'"
  );
const recoveryDue = async () =>
  (await db.root<{ due: boolean }>('select private.launch_catalog_recovery_due() due'))[0]!.due;
const variantRoundsDue = async () =>
  (
    await db.root<{ due: boolean }>(
      'select private.launch_catalog_recovery_due_before_variant_rounds() due'
    )
  )[0]!.due;
const job = async (id: string) =>
  (
    await db.root<{ state: string; blocked_reason: string | null }>(
      'select state,blocked_reason from private.catalog_video_publication_jobs where id=$1',
      [id]
    )
  )[0]!;

it('an idle space keeps the updater asleep', async () => {
  await clear();
  expect(await recoveryDue()).toBe(false);
  expect(await variantRoundsDue()).toBe(false);
});

it('a scheduled link that is not due yet is not work', async () => {
  await clear();
  await publication({ dueAgo: '-2 hours' });
  expect(await recoveryDue()).toBe(false);
  expect(await variantRoundsDue()).toBe(false);
});

it('a due job the claim would not take yet is not work: backed off, or its Drive needs reconnecting', async () => {
  await clear();
  await publication({ dueAgo: '2 hours', nextIn: '10 minutes' });
  expect(await recoveryDue()).toBe(false);
  expect(await variantRoundsDue()).toBe(false);
  await clear();
  await publication({ dueAgo: '2 hours', connected: false });
  expect(await recoveryDue()).toBe(false);
  expect(await variantRoundsDue()).toBe(false);
});

it('a due job the claim would take is work', async () => {
  await clear();
  await publication({ dueAgo: '2 hours' });
  expect(await recoveryDue()).toBe(true);
  expect(await variantRoundsDue()).toBe(true);
  await clear();
});

it('a job still undispatched a day after it was due is closed with a closed reason', async () => {
  await clear();
  const stale = await publication({
    dueAgo: '40 hours',
    createdAgo: '40 hours',
    nextIn: '5 minutes'
  });
  const unreachable = await publication({
    dueAgo: '40 hours',
    createdAgo: '40 hours',
    connected: false
  });
  const recent = await publication({ dueAgo: '2 hours', createdAgo: '2 hours' });
  const result = (
    await db.root<{ v: { blocked: number } }>('select private.settle_catalog_stuck_shapes(20) v')
  )[0]!.v;
  expect(result.blocked).toBe(2);
  expect(await job(stale.job)).toEqual({ state: 'blocked', blocked_reason: 'stale_job' });
  expect(await job(unreachable.job)).toEqual({
    state: 'blocked',
    blocked_reason: 'target_unavailable'
  });
  expect(await job(recent.job)).toEqual({ state: 'retry_wait', blocked_reason: null });
  await clear();
  expect(await recoveryDue()).toBe(false);
});

it('the settling pass runs every ten minutes, independent of the updater', async () => {
  // The test database stubs pg_cron, so the schedule is read from the migration itself.
  const sql = readFileSync(
    new URL('../supabase/migrations/20261207399920_catalog_prod_stuck_shapes.sql', import.meta.url),
    'utf8'
  );
  expect(sql).toContain(
    "cron.schedule('soty-catalog-stuck-shapes','*/10 * * * *',$cron$select private.settle_catalog_stuck_shapes()$cron$)"
  );
});
