import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 012 (T001/T002): a transcript companion is linked 1:1 to its video,
 * unique among live rows, and readable by a member through the companion RPC.
 */

const OWNER = '27000000-0000-4000-8000-000000000001';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;
let videoId: string;

async function material(name: string, kind: string, category: string | null, overrides = '') {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type${overrides ? ', ' + overrides.split('=')[0] : ''})
     values ($1, $2, $3, 'root', $3, $4, $5, 'application/octet-stream'${overrides ? ', ' + overrides.split('=')[1] : ''})
     returning id`,
    [teamId, connectionId, name, kind, category]
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@comp.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Companions']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-comp', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
  connectionId = connection[0]!.id;
  videoId = await material('clip.mp4', 'file', 'video');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function companion(name: string, video: string) {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
        companion_of, companion_kind, transcript_ingest_state, transcript_text)
     values ($1, $2, $3, 'root', $3, 'file', 'transcript', 'text/plain', $4, 'transcript', 'full', 'hello there')
     returning id`,
    [teamId, connectionId, name, video]
  );
  return rows[0]!.id;
}

describe('media companions', () => {
  it('links a transcript to its video and reads it back', async () => {
    const c = await companion('clip.txt', videoId);
    const read = await harness.asUser<{ id: string; name: string; has_text: boolean }>(
      OWNER,
      'select * from public.get_material_transcript_companion($1, $2)',
      [teamId, videoId]
    );
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: c, name: 'clip.txt', has_text: true });
  }, 60_000);

  it('allows only one live transcript companion per video', async () => {
    await expect(companion('clip-2.txt', videoId)).rejects.toThrow();
  }, 60_000);

  it('refuses a companion kind that is not a transcript, and a bad fingerprint', async () => {
    await expect(
      harness.root(
        `insert into public.team_materials
           (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
            companion_of, companion_kind)
         values ($1, $2, 'x', 'root', 'x', 'file', 'other', 'text/plain', $3, 'thumbnail')`,
        [teamId, connectionId, videoId]
      )
    ).rejects.toThrow(/companion_kind_check/);
    await expect(
      harness.root(`update public.team_materials set audio_fingerprint = 'nothex' where id = $1`, [
        videoId
      ])
    ).rejects.toThrow(/audio_fingerprint_check/);
  }, 60_000);
});

describe('landing preview lifecycle (012, T013)', () => {
  it('stops serving a landing render once the landing is trashed', async () => {
    const landing = await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
          drive_version, checksum)
       values ($1, $2, 'land-1', 'root', 'promo.html', 'file', 'landing', 'text/html', 'v1', 'c1')
       returning id`,
      [teamId, connectionId]
    );
    await harness.root(
      `insert into public.team_landing_renders
         (team_id, material_id, preset, source_version, source_checksum, fingerprint,
          render_state, artifact_root, segment_count)
       values ($1, $2, 'default', 'v1', 'c1', $3, 'ready', 'art-root', 1)`,
      [teamId, landing[0]!.id, 'a'.repeat(64)]
    );
    const before = await harness.asUser<{ material_id: string; render_state: string }>(
      OWNER,
      'select * from public.list_landing_renders($1, $2, $3)',
      [teamId, [landing[0]!.id], 'default']
    );
    expect(before).toHaveLength(1);
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [landing[0]!.id]
    );
    const after = await harness.asUser(
      OWNER,
      'select * from public.list_landing_renders($1, $2, $3)',
      [teamId, [landing[0]!.id], 'default']
    );
    expect(after).toHaveLength(0);
  }, 60_000);
});
