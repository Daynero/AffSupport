import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '26300000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let connection: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'scope@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Scope joins')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
    (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
    values ('scope-join', 'scope@example.test', 'https://www.googleapis.com/auth/drive.file',
      gen_random_uuid(), $1) returning id`,
    [owner]
  );
  const [drive] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
    (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state)
    values ($1,$2,'root','Root','my_drive','connected') returning id`,
    [team, credential!.id]
  );
  connection = drive!.id;
  await db.root(
    `insert into public.team_materials
      (team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
    values ($1,$2,'root',null,'Root','folder'),
      ($1,$2,'doctors','root','Doctors','folder'),
      ($1,$2,'please','doctors','Please','folder'),
      ($1,$2,'campaign','root','Campaign','folder'),
      ($1,$2,'other','campaign','Other','folder')`,
    [team, connection]
  );
}, 60_000);

afterAll(async () => db?.close());

const request = async (folder: string) => {
  const [row] = await db.asUser<{ sync_job_id: string }>(
    owner,
    'select * from public.request_team_folder_resync($1,$2)',
    [team, folder]
  );
  return row!.sync_job_id;
};

describe('manual sync scope joins', () => {
  it('joins a descendant request and widens an untouched queued job', async () => {
    const job = await request('doctors');
    expect(await request('please')).toBe(job);
    expect(await request('root')).toBe(job);
    expect(
      await db.root(
        'select requested_folder_id, folder_queue from private.catalog_sync_jobs where id = $1',
        [job]
      )
    ).toEqual([{ requested_folder_id: 'root', folder_queue: ['root'] }]);
    await db.root("update private.catalog_sync_jobs set state = 'succeeded' where id = $1", [job]);
  });

  it('creates one broader follow-up after a descendant scan has started', async () => {
    const narrow = await request('other');
    await db.root(
      `update private.catalog_sync_jobs set state = 'leased', scan_initialized = true,
        lease_owner = 'running', lease_expires_at = now() + interval '3 minutes'
      where id = $1`,
      [narrow]
    );
    const broad = await request('campaign');
    expect(broad).not.toBe(narrow);
    expect(await request('campaign')).toBe(broad);
    expect(await request('other')).toBe(narrow);
    expect(
      await db.root<{ requested_folder_id: string }>(
        `select requested_folder_id from private.catalog_sync_jobs
      where connection_id = $1 and job_kind = 'user_subtree' and state in ('pending','leased','retry')
      order by requested_folder_id`,
        [connection]
      )
    ).toEqual([{ requested_folder_id: 'campaign' }, { requested_folder_id: 'other' }]);
  });
});
