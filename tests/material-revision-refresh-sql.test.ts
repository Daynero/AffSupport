import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * A material whose Drive version moved without its bytes (sharing by link does that): process start
 * brings the row up to the live version, so finalize does not refuse an unchanged source.
 */

const OWNER = '23400000-0000-4000-8000-000000000001';
let harness: TeamTestDb;
let video: string;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@revision.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const teamId = (
    await harness.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', ['Rev'])
  )[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-rev', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
  video = (
    await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          drive_version, checksum)
       values ($1, $2, 'drive-video', 'root', 'shared.mp4', 'file', 'video', 'video/mp4', '17', 'abc')
       returning id`,
      [teamId, connection[0]!.id]
    )
  )[0]!.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

const refresh = async (driveFileId: string, version: string, checksum: string | null) =>
  (
    await harness.root<{ ok: boolean }>(
      'select public.service_refresh_material_revision($1, $2, $3, $4) as ok',
      [video, driveFileId, version, checksum]
    )
  )[0]!.ok;

const version = async () =>
  (
    await harness.root<{ drive_version: string }>(
      'select drive_version from public.team_materials where id = $1',
      [video]
    )
  )[0]!.drive_version;

describe('refreshing a material revision', () => {
  it('leaves different bytes, another file and an empty checksum alone', async () => {
    expect(await refresh('drive-video', '19', 'other')).toBe(false);
    expect(await refresh('drive-other', '19', 'abc')).toBe(false);
    expect(await refresh('drive-video', '19', null)).toBe(false);
    expect(await version()).toBe('17');
  }, 60_000);

  it('takes the live version when the bytes are the ones on record, once', async () => {
    expect(await refresh('drive-video', '19', 'abc')).toBe(true);
    expect(await refresh('drive-video', '19', 'abc')).toBe(false);
    expect(await version()).toBe('19');
  }, 60_000);

  it('is for the service role only', async () => {
    const rows = await harness.root<{ allowed: boolean }>(
      `select has_function_privilege('authenticated',
         'public.service_refresh_material_revision(uuid, text, text, text)', 'execute') as allowed`
    );
    expect(rows[0]!.allowed).toBe(false);
  }, 60_000);
});
