import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '26500000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let connection: string;
let canonical: string;
let epoch: number;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'discovered@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Discovered subtree')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
    values ('discovered','discovered@example.test','https://www.googleapis.com/auth/drive.file',
      gen_random_uuid(),$1) returning id`,
    [owner]
  );
  const [drive] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
    values ($1,$2,'root','Root','my_drive','connected') returning id`,
    [team, credential!.id]
  );
  connection = drive!.id;
  await db.root(
    `insert into public.team_materials
      (team_id,connection_id,drive_file_id,parent_folder_id,name,kind)
    values ($1,$2,'root',null,'Root','folder')`,
    [team, connection]
  );
  const [job] = await db.root<{ id: string }>(
    `insert into private.catalog_sync_jobs
      (connection_id,job_kind,phase,cursor)
    values ($1,'incremental','incremental','{"pageToken":"change-1","changePageToken":"change-1"}')
    returning id`,
    [connection]
  );
  canonical = job!.id;
  const [claim] = await db.root<{ job_id: string; lease_epoch: number }>(
    "select job_id, lease_epoch from public.service_claim_catalog_sync_work('discovered-worker',1,180)"
  );
  expect(claim?.job_id).toBe(canonical);
  epoch = claim!.lease_epoch;
}, 60_000);

afterAll(async () => db?.close());

const enqueue = async (folder: string, parent = 'root') => {
  const [result] = await db.root<{ accepted: boolean }>(
    `select public.service_enqueue_discovered_catalog_subtree($1,'discovered-worker',$2,$3,$4) as accepted`,
    [canonical, epoch, folder, parent]
  );
  return result?.accepted;
};

describe('discovered folder scope joins', () => {
  it('creates one finite job for a new folder and lets manual sync join it', async () => {
    expect(await enqueue('new-folder')).toBe(true);
    expect(await enqueue('new-folder')).toBe(true);
    const [discovered] = await db.root<{ id: string }>(
      `select id from private.catalog_sync_jobs
       where connection_id = $1 and job_kind = 'discovered_subtree'
         and requested_folder_id = 'new-folder'`,
      [connection]
    );
    expect(discovered?.id).toBeTruthy();
    await db.root(
      `insert into public.team_materials
        (team_id,connection_id,drive_file_id,parent_folder_id,name,kind)
       values ($1,$2,'new-folder','root','New folder','folder')`,
      [team, connection]
    );
    const [manual] = await db.asUser<{ sync_job_id: string }>(
      owner,
      'select * from public.request_team_folder_resync($1,$2)',
      [team, 'new-folder']
    );
    expect(manual?.sync_job_id).toBe(discovered?.id);
  });

  it('skips an already indexed unchanged folder but rescans a moved or restored folder', async () => {
    await db.root(
      `insert into public.team_materials
        (team_id,connection_id,drive_file_id,parent_folder_id,name,kind,folder_indexed_at)
       values ($1,$2,'covered','root','Covered','folder',now()),
              ($1,$2,'moved','old-parent','Moved','folder',now()),
              ($1,$2,'restored','root','Restored','folder',now())`,
      [team, connection]
    );
    await db.root(
      `update public.team_materials set lifecycle = 'missing', missing_at = now()
       where connection_id = $1 and drive_file_id = 'restored'`,
      [connection]
    );
    expect(await enqueue('covered')).toBe(true);
    expect(await enqueue('moved')).toBe(true);
    expect(await enqueue('restored')).toBe(true);
    expect(
      await db.root<{ requested_folder_id: string }>(
        `select requested_folder_id from private.catalog_sync_jobs
         where connection_id = $1 and job_kind = 'discovered_subtree'
           and requested_folder_id in ('covered','moved','restored')
         order by requested_folder_id`,
        [connection]
      )
    ).toEqual([{ requested_folder_id: 'moved' }, { requested_folder_id: 'restored' }]);
  });

  it('creates one follow-up if an ancestor scan has already passed the parent', async () => {
    const [ancestor] = await db.root<{ id: string }>(
      `insert into private.catalog_sync_jobs
        (connection_id,job_kind,phase,cursor,folder_queue,requested_folder_id,scan_initialized,state)
       values ($1,'user_subtree','initial_scan','{}','["root"]','root',true,'leased')
       returning id`,
      [connection]
    );
    await db.root(
      `insert into private.catalog_scan_frontier(job_id,folder_id,state)
       values ($1,'root','done')`,
      [ancestor!.id]
    );
    expect(await enqueue('late-folder')).toBe(true);
    expect(await enqueue('late-folder')).toBe(true);
    const jobs = await db.root<{ id: string }>(
      `select id from private.catalog_sync_jobs
       where connection_id = $1 and requested_folder_id = 'late-folder'
         and state in ('pending','leased','retry')`,
      [connection]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).not.toBe(ancestor?.id);
  });
});
