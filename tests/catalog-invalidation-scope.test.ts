import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '26400000-0000-4000-8000-000000000001';
let db: TeamTestDb;
let team: string;
let materialId: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'scope-owner@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Scoped events')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
     values ('scope-events','scope-owner@example.test','https://www.googleapis.com/auth/drive.file',
       gen_random_uuid(),$1) returning id`,
    [owner]
  );
  const [connection] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
      (team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state)
     values ($1,$2,'root','Root','my_drive','connected') returning id`,
    [team, credential!.id]
  );
  const [material] = await db.root<{ id: string }>(
    `insert into public.team_materials
      (team_id,connection_id,drive_file_id,parent_folder_id,name,kind)
     values ($1,$2,'file','old-folder','File','file') returning id`,
    [team, connection!.id]
  );
  materialId = material!.id;
}, 60_000);

afterAll(async () => db?.close());

describe('catalog invalidation scope', () => {
  it('emits old and new parent windows atomically when a material moves', async () => {
    await db.root('update public.team_materials set parent_folder_id = $1 where id = $2', [
      'new-folder',
      materialId
    ]);
    expect(
      await db.root<{ parent_folder_id: string }>(
        `select parent_folder_id from public.team_catalog_events
         where material_id = $1 order by id`,
        [materialId]
      )
    ).toEqual([{ parent_folder_id: 'old-folder' }, { parent_folder_id: 'new-folder' }]);
  });

  it('does not emit scoped move events for a same-parent edit', async () => {
    await db.root('update public.team_materials set name = $1 where id = $2', [
      'Renamed',
      materialId
    ]);
    const [count] = await db.root<{ count: number }>(
      'select count(*)::int as count from public.team_catalog_events where material_id = $1',
      [materialId]
    );
    expect(count?.count).toBe(2);
  });
});
