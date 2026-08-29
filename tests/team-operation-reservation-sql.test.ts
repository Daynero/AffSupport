import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (findings M1): a move that reserves a name and then fails must
 * release that name, so a fresh attempt is not refused with a phantom name
 * conflict. `withOperationFailure` in drive-ops calls the transition this test
 * pins: failed releases the reservation, and the next reservation of the same
 * name then succeeds.
 */

const OWNER = '26000000-0000-4000-8000-000000000001';

let harness: TeamTestDb;
let teamId: string;
let fileId: string;
let folderId: string;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@resv.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Reservation']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-resv', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
     values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  const folder = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, mime_type)
     values ($1, $2, 'f-dest', 'root', 'Dest', 'folder', 'application/vnd.google-apps.folder')
     returning id`,
    [teamId, connection[0]!.id]
  );
  folderId = folder[0]!.id;
  const file = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values ($1, $2, 'f-clip', 'root', 'clip.mp4', 'file', 'video', 'video/mp4')
     returning id`,
    [teamId, connection[0]!.id]
  );
  fileId = file[0]!.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function startMove(idempotencyKey: string) {
  return harness.asUser<{ operation_id: string; state: string; reused: boolean }>(
    OWNER,
    `select * from public.service_start_team_operation(
       $1, $2, 'move', $3, $3, $4, $5, 'clip.mp4', now() + interval '15 minutes', 0)`,
    [teamId, OWNER, idempotencyKey, fileId, folderId]
  );
}

describe('name reservation release on failure', () => {
  it('a fresh attempt is refused while the first still holds the name', async () => {
    await startMove('move-key-aaaaaa-1');
    // A different key (a new drag) reserves the same name → conflict, which is
    // exactly the "file already exists" the owner saw on the second try.
    await expect(startMove('move-key-bbbbbb-2')).rejects.toThrow(/NAME_CONFLICT/);
  }, 60_000);

  it('marking the first failed releases the name, and the retry goes through', async () => {
    const held = await harness.root<{ id: string }>(
      `select id from public.team_operations
        where team_id = $1 and kind = 'move' and reservation_released_at is null
        order by created_at limit 1`,
      [teamId]
    );
    await harness.root(
      `select public.service_transition_team_operation($1, 'failed', 'failed', 100, null, 'DRIVE_UNAVAILABLE', true)`,
      [held[0]!.id]
    );
    const released = await harness.root<{ reservation_released_at: string | null }>(
      'select reservation_released_at from public.team_operations where id = $1',
      [held[0]!.id]
    );
    expect(released[0]!.reservation_released_at).not.toBeNull();
    // The name is free now: a fresh move reserves it without a conflict.
    const retry = await startMove('move-key-cccccc-3');
    expect(retry[0]).toMatchObject({ state: 'pending', reused: false });
  }, 60_000);
});
