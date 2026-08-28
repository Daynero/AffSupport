import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (T010): storage selections against a real Postgres with every
 * migration applied. The guards, not the happy path alone: exactly one root
 * per connection, the root cannot be removed, a duplicate folder is refused,
 * members read through the definer function and nobody writes the table
 * directly.
 */

const OWNER = '20000000-0000-4000-8000-000000000001';
const VIEWER = '20000000-0000-4000-8000-000000000002';
const STRANGER = '20000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@example.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@example.test', displayName: 'Viewer' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@example.test',
    displayName: 'Stranger'
  });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function makeSpace(name: string): Promise<{ teamId: string; connectionId: string }> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    [name]
  );
  const teamId = rows[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ($1, $2, 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $3)
     returning id`,
    [`perm-${teamId}`, 'owner@example.test', OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root-folder', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  return { teamId, connectionId: connection[0]!.id };
}

describe('team_drive_selections', () => {
  it('creates the root selection with the connection and lists it to members only', async () => {
    const { teamId } = await makeSpace('Selections A');
    const forOwner = await harness.asUser<{ drive_folder_id: string; is_root: boolean }>(
      OWNER,
      'select * from public.list_team_drive_selections($1)',
      [teamId]
    );
    expect(forOwner).toEqual([
      expect.objectContaining({ drive_folder_id: 'root-folder', is_root: true, state: 'active' })
    ]);
    const forViewer = await harness.asUser(
      VIEWER,
      'select * from public.list_team_drive_selections($1)',
      [teamId]
    );
    expect(forViewer).toHaveLength(1);
    await expect(
      harness.asUser(STRANGER, 'select * from public.list_team_drive_selections($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    // Row-level security and the column grant are asserted in the pgTAP suite:
    // the PGlite harness runs as a superuser, which bypasses both.
  });

  it('keeps exactly one root per connection when the root changes', async () => {
    const { connectionId } = await makeSpace('Selections B');
    await harness.root(
      `update public.team_drive_connections set root_folder_id = 'root-2', root_folder_name = 'Root 2'
       where id = $1`,
      [connectionId]
    );
    const roots = await harness.root<{ drive_folder_id: string }>(
      `select drive_folder_id from public.team_drive_selections
       where connection_id = $1 and is_root`,
      [connectionId]
    );
    expect(roots).toEqual([{ drive_folder_id: 'root-2' }]);
  });

  it('adds a picked folder once, walks it, and refuses a duplicate or a viewer', async () => {
    const { teamId, connectionId } = await makeSpace('Selections C');
    const added = await harness.asUser<{ id: string; is_root: boolean; state: string }>(
      OWNER,
      `select * from public.add_team_drive_selection($1, 'campaigns', null, 'Campaigns')`,
      [teamId]
    );
    expect(added[0]).toMatchObject({ is_root: false, state: 'active' });
    const jobs = await harness.root<{ folder_queue: unknown }>(
      `select folder_queue from private.catalog_sync_jobs
       where connection_id = $1 and phase = 'initial_scan' order by created_at desc limit 1`,
      [connectionId]
    );
    expect(jobs[0]?.folder_queue).toEqual(['campaigns']);
    await expect(
      harness.asUser(
        OWNER,
        `select * from public.add_team_drive_selection($1, 'campaigns', null, 'Again')`,
        [teamId]
      )
    ).rejects.toThrow(/SELECTION_UNREACHABLE/);
    await expect(
      harness.asUser(
        VIEWER,
        `select * from public.add_team_drive_selection($1, 'other', null, 'Other')`,
        [teamId]
      )
    ).rejects.toThrow(/PERMISSION_DENIED/);
    const audit = await harness.root<{ action: string }>(
      `select action from public.team_audit_events where team_id = $1 order by occurred_at desc limit 1`,
      [teamId]
    );
    expect(audit[0]?.action).toBe('storage.selection_added');
  });

  it('never removes the root, and removing a picked folder tombstones exactly its descendants', async () => {
    const { teamId, connectionId } = await makeSpace('Selections D');
    const root = await harness.root<{ id: string }>(
      `select id from public.team_drive_selections where connection_id = $1 and is_root`,
      [connectionId]
    );
    await expect(
      harness.asUser(OWNER, 'select public.remove_team_drive_selection($1, $2)', [
        teamId,
        root[0]!.id
      ])
    ).rejects.toThrow(/ROOT_SELECTION_REQUIRED/);

    const added = await harness.asUser<{ id: string }>(
      OWNER,
      `select id from public.add_team_drive_selection($1, 'picked', null, 'Picked')`,
      [teamId]
    );
    await harness.root(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values
         ($1, $2, 'sub', 'picked', 'Sub', 'folder', null, 'application/vnd.google-apps.folder'),
         ($1, $2, 'deep.png', 'sub', 'deep.png', 'file', 'image', 'image/png'),
         ($1, $2, 'top.png', 'root-folder', 'top.png', 'file', 'image', 'image/png')`,
      [teamId, connectionId]
    );
    const assigned = await harness.root<{ drive_file_id: string; picked: boolean }>(
      `select material.drive_file_id, material.selection_id = $2 as picked
       from public.team_materials as material where material.team_id = $1
       order by material.drive_file_id`,
      [teamId, added[0]!.id]
    );
    expect(assigned).toEqual([
      { drive_file_id: 'deep.png', picked: true },
      { drive_file_id: 'sub', picked: true },
      { drive_file_id: 'top.png', picked: false }
    ]);

    await harness.asUser(OWNER, 'select public.remove_team_drive_selection($1, $2)', [
      teamId,
      added[0]!.id
    ]);
    const after = await harness.root<{ drive_file_id: string; lifecycle: string }>(
      `select drive_file_id, lifecycle from public.team_materials where team_id = $1
       order by drive_file_id`,
      [teamId]
    );
    expect(after).toEqual([
      { drive_file_id: 'deep.png', lifecycle: 'missing' },
      { drive_file_id: 'sub', lifecycle: 'missing' },
      { drive_file_id: 'top.png', lifecycle: 'active' }
    ]);
    const listed = await harness.asUser<{ drive_folder_id: string }>(
      OWNER,
      'select drive_folder_id from public.list_team_drive_selections($1)',
      [teamId]
    );
    expect(listed).toEqual([{ drive_folder_id: 'root-folder' }]);
  });
});
