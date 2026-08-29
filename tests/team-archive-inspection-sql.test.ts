import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (findings J2): new archives are handed to the inspector once,
 * and its decision changes the catalog only for the version it looked at.
 */

const OWNER = '25000000-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;

async function material(name: string, category: string, version = 'v1'): Promise<string> {
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
        size_bytes, drive_version)
     values ($1, $2, $3, 'root', $3, 'file', $4, 'application/zip', 4096, $5)
     returning id`,
    [teamId, connectionId, name, category, version]
  );
  return rows[0]!.id;
}

async function claim() {
  return harness.root<{ material_id: string; drive_version: string; size_bytes: string | number }>(
    'select material_id, drive_version, size_bytes from public.service_claim_archive_inspections(20)'
  );
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@inspect.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Inspect']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-inspect', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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

describe('archive inspection', () => {
  it('claims new archives once and promotes the one with a page inside', async () => {
    const landing = await material('landing.zip', 'archive');
    const plain = await material('photos.zip', 'archive');
    await material('clip.mp4', 'video');

    const first = await claim();
    expect(first.map(row => row.material_id).sort()).toEqual([landing, plain].sort());
    expect(await claim()).toEqual([]); // claimed, not offered again for ten minutes

    expect(
      await harness.root<{ ok: boolean }>(
        `select public.service_commit_archive_inspection($1, 'landing', 'v1', $2) as ok`,
        [landing, FINGERPRINT]
      )
    ).toEqual([{ ok: true }]);
    expect(
      await harness.root<{ ok: boolean }>(
        `select public.service_commit_archive_inspection($1, 'archive', 'v1') as ok`,
        [plain]
      )
    ).toEqual([{ ok: true }]);

    const rows = await harness.root<{
      name: string;
      category: string;
      classification_source: string;
      landing_validation_state: string;
      preview_state: string;
      kind: string;
    }>(
      `select material.name, material.category, material.classification_source,
              material.landing_validation_state, material.preview_state,
              public.team_material_kind(material.kind, material.mime_type, material.category) as kind
         from public.team_materials as material
        where material.id in ($1, $2) order by material.name`,
      [landing, plain]
    );
    expect(rows).toEqual([
      {
        name: 'landing.zip',
        category: 'landing',
        classification_source: 'inspected_landing',
        landing_validation_state: 'validated',
        preview_state: 'pending',
        kind: 'landing'
      },
      {
        name: 'photos.zip',
        category: 'archive',
        classification_source: 'fallback',
        landing_validation_state: 'invalid',
        preview_state: 'pending',
        kind: 'archive'
      }
    ]);
    // Both decided: nothing left to claim.
    expect(await claim()).toEqual([]);
  }, 60_000);

  it('drops a decision made about a version that has since changed', async () => {
    const changed = await material('moved-on.zip', 'archive', 'v2');
    await claim();
    expect(
      await harness.root<{ ok: boolean }>(
        `select public.service_commit_archive_inspection($1, 'landing', 'v1', $2) as ok`,
        [changed, FINGERPRINT]
      )
    ).toEqual([{ ok: false }]);
    const row = await harness.root<{ category: string; landing_validation_state: string | null }>(
      'select category, landing_validation_state from public.team_materials where id = $1',
      [changed]
    );
    expect(row[0]).toEqual({ category: 'archive', landing_validation_state: null });
  }, 60_000);
});
