import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

const owner = '26600000-0000-4000-8000-000000000001';
const outsider = '26600000-0000-4000-8000-000000000002';
let db: TeamTestDb;
let team: string;
let connection: string;
let canonical: string;

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'health-owner@example.test' });
  await createUser(db, { id: outsider, email: 'health-outsider@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [created] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Coverage health')"
  );
  team = created!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
      (google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
     values ('coverage','health-owner@example.test','https://www.googleapis.com/auth/drive.file',
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
  const [job] = await db.root<{ id: string }>(
    `insert into private.catalog_sync_jobs(connection_id,job_kind,phase,cursor)
     values ($1,'incremental','incremental','{}') returning id`,
    [connection]
  );
  canonical = job!.id;
}, 60_000);

afterAll(async () => db?.close());

const health = async () => {
  const [row] = await db.asUser<{ value: Record<string, unknown> }>(
    owner,
    'select public.get_team_storage_health_v2($1) as value',
    [team]
  );
  return row!.value;
};

describe('catalog coverage health projection', () => {
  it('does not turn an empty but unconfirmed catalog into complete coverage', async () => {
    expect(await health()).toMatchObject({ coverage: 'unknown', nextAction: 'wait' });
    await db.root(
      `update public.team_drive_connections
       set initial_sync_state = 'ready', last_synced_at = now() where id = $1`,
      [connection]
    );
    expect(await health()).toMatchObject({
      coverage: 'complete',
      syncHealth: 'current',
      nextAction: 'none'
    });
  });

  it('shows a failed finite scan as partial while retaining its last confirmed time', async () => {
    await db.root(
      `insert into private.catalog_sync_jobs
       (connection_id,job_kind,phase,cursor,requested_folder_id,state,last_error_code)
       values ($1,'user_subtree','initial_scan','{}','root','failed','INVALID_RESPONSE')`,
      [connection]
    );
    expect(await health()).toMatchObject({ coverage: 'partial', nextAction: 'retry' });
    expect((await health()).lastConfirmedAt).toBeTruthy();
  });

  it('does not claim complete coverage while a newly discovered subtree is still queued', async () => {
    await db.root(
      `insert into private.catalog_sync_jobs
       (connection_id,job_kind,phase,cursor,requested_folder_id,state)
       values ($1,'discovered_subtree','initial_scan','{}','moved-in','pending')`,
      [connection]
    );
    expect(await health()).toMatchObject({ coverage: 'partial', syncHealth: 'working' });
  });

  it('separates provider rate-limit delay from an authorization failure', async () => {
    await db.root(
      `update private.catalog_sync_jobs set state = 'retry', last_error_code = 'RATE_LIMITED'
       where id = $1`,
      [canonical]
    );
    expect(await health()).toMatchObject({ syncHealth: 'delayed', nextAction: 'wait' });
    await db.root(`update public.team_drive_connections set state = 'needs_reauth' where id = $1`, [
      connection
    ]);
    expect(await health()).toMatchObject({
      coverage: 'permission_limited',
      syncHealth: 'needs_reauth',
      nextAction: 'reconnect'
    });
  });

  it('refuses a non-member without exposing the projection', async () => {
    await expect(
      db.asUser(outsider, 'select public.get_team_storage_health_v2($1)', [team])
    ).rejects.toThrow('PERMISSION_DENIED');
  });
});
