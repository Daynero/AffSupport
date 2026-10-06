import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const OWNER = 'a6200000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let connection: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'manual-resync@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [OWNER]);
  team = (
    await db.asUser<{ id: string }>(OWNER, "select id from public.create_team('Manual resync')")
  )[0]!.id;
  const credential = (
    await db.root<{ id: string }>(
      `insert into private.google_drive_credentials
      (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
     values ('manual-resync','manual-resync@example.test',
       'https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$1) returning id`,
      [OWNER]
    )
  )[0]!.id;
  connection = (
    await db.root<{ id: string }>(
      `insert into public.team_drive_connections
      (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
     values ($1,$2,'root','Root','my_drive','connected') returning id`,
      [team, credential]
    )
  )[0]!.id;
  await db.root(
    `insert into public.team_drive_selections
      (team_id,connection_id,drive_folder_id,name,is_root,state,selected_by)
     values ($1,$2,'extra','Extra',false,'active',$3)`,
    [team, connection, OWNER]
  );
  await db.root(
    `insert into public.team_materials
      (team_id,connection_id,drive_file_id,parent_folder_id,name,kind)
     values ($1,$2,'narrow','root','Narrow','folder')`,
    [team, connection]
  );
}, 60_000);

afterAll(async () => db?.close());

describe('full manual Drive resync', () => {
  it('keeps every selected folder and exposes the actual job result', async () => {
    const narrow = (
      await db.asUser<{ sync_job_id: string }>(
        OWNER,
        'select * from public.request_team_folder_resync($1,$2)',
        [team, 'narrow']
      )
    )[0]!.sync_job_id;
    const request = () =>
      db.asUser<{ sync_job_id: string }>(
        OWNER,
        'select * from public.request_team_catalog_resync($1)',
        [team]
      );
    const id = (await request())[0]!.sync_job_id;
    expect(id).not.toBe(narrow);
    expect((await request())[0]!.sync_job_id).toBe(id);
    const job = (
      await db.root<{ folder_queue: string[]; job_kind: string }>(
        'select folder_queue, job_kind from private.catalog_sync_jobs where id = $1',
        [id]
      )
    )[0]!;
    expect(job.job_kind).toBe('initial');
    expect(job.folder_queue).toEqual(['root', 'extra']);

    const status = async () =>
      (
        await db.asUser<{ status: string }>(
          OWNER,
          'select * from public.get_team_folder_resync_status($1,$2)',
          [team, id]
        )
      )[0]?.status;
    expect(await status()).toBe('running');
    await db.root("update private.catalog_sync_jobs set state = 'failed' where id = $1", [id]);
    expect(await status()).toBe('failed');
  });

  it('queues a fresh complete scan if the existing full scan has already started', async () => {
    const old = (
      await db.asUser<{ sync_job_id: string }>(
        OWNER,
        'select * from public.request_team_catalog_resync($1)',
        [team]
      )
    )[0]!.sync_job_id;
    await db.root('update private.catalog_sync_jobs set scan_initialized = true where id = $1', [
      old
    ]);
    const fresh = (
      await db.asUser<{ sync_job_id: string }>(
        OWNER,
        'select * from public.request_team_catalog_resync($1)',
        [team]
      )
    )[0]!.sync_job_id;
    expect(fresh).not.toBe(old);
    const queue = (
      await db.root<{ folder_queue: string[] }>(
        'select folder_queue from private.catalog_sync_jobs where id = $1',
        [fresh]
      )
    )[0]!.folder_queue;
    expect(queue).toEqual(['root', 'extra']);
  });
});
