import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * `record_material_source_language` (020): a transcription writes the language
 * it heard onto the video, and never over a language a person chose.
 */

const OWNER = '28000000-0000-4000-8000-000000000001';
const VIEWER = '28000000-0000-4000-8000-000000000002';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;

async function material(name: string, language: string | null = null): Promise<string> {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category,
        mime_type, lifecycle, language)
     values ($1, $2, $3, 'root', $3, 'file', 'video', 'video/mp4', 'active', $4)
     returning id`,
    [teamId, connectionId, name, language]
  );
  return rows[0]!.id;
}

async function record(materialId: string, language: string, as = OWNER): Promise<boolean> {
  const rows = await harness.asUser<{ recorded: boolean }>(
    as,
    'select public.record_material_source_language($1, $2, $3) as recorded',
    [teamId, materialId, language]
  );
  return rows[0]!.recorded;
}

async function languageOf(materialId: string) {
  const rows = await harness.root<{ language: string | null; source: string | null }>(
    `select language, language_decision_source as source
     from public.team_materials where id = $1`,
    [materialId]
  );
  return rows[0]!;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@lang.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@lang.test', displayName: 'Viewer' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Languages']
  );
  teamId = team[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-lang', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('record_material_source_language', () => {
  it('fills an empty language and says the decision was automatic', async () => {
    const id = await material('heard.mp4');
    expect(await record(id, 'uk')).toBe(true);
    expect(await languageOf(id)).toEqual({ language: 'uk', source: 'automatic' });
  });

  it('leaves a language a person chose exactly as it is', async () => {
    const id = await material('chosen.mp4', 'en');
    // A member looked at this file; a detector listened to half a minute of it.
    expect(await record(id, 'uk')).toBe(false);
    expect((await languageOf(id)).language).toBe('en');
  });

  it('takes a regional tag as its base language, and refuses what the catalogue has no code for', async () => {
    const regional = await material('regional.mp4');
    expect(await record(regional, 'en-GB')).toBe(true);
    expect((await languageOf(regional)).language).toBe('en');

    const unknown = await material('unknown.mp4');
    // Whisper answers `auto` when it was not asked to detect anything.
    expect(await record(unknown, 'auto')).toBe(false);
    expect((await languageOf(unknown)).language).toBeNull();
  });

  it('announces the change so open catalogues follow it', async () => {
    const id = await material('announced.mp4');
    await record(id, 'pl');
    const events = await harness.root<{ count: string }>(
      `select count(*)::text as count from public.team_catalog_events
       where team_id = $1 and material_id = $2 and event_kind = 'upserted'`,
      [teamId, id]
    );
    expect(Number(events[0]!.count)).toBeGreaterThan(0);
  });

  it('refuses a member who cannot manage metadata', async () => {
    const id = await material('guarded.mp4');
    await expect(record(id, 'uk', VIEWER)).rejects.toThrow(/PERMISSION_DENIED/);
    expect((await languageOf(id)).language).toBeNull();
  });
});
