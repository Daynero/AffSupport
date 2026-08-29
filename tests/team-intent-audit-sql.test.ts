import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (findings H3): a trash, restore or move that completes through
 * `service_complete_material_group_intent` is written to the space history,
 * the way a rename already was through the transfer commit.
 */

const OWNER = '23000000-0000-4000-8000-000000000001';

let harness: TeamTestDb;
let teamId: string;
let materialId: string;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@intent.test', displayName: 'Owner' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  const team = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    ['Intent audit']
  );
  teamId = team[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-intent', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
  const material = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values ($1, $2, 'i1', 'root', 'banner.png', 'file', 'image', 'image/png')
     returning id`,
    [teamId, connection[0]!.id]
  );
  materialId = material[0]!.id;
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function runningIntent(action: 'trash' | 'restore' | 'move'): Promise<string> {
  const operation = await harness.root<{ id: string }>(
    `insert into public.team_operations
       (team_id, actor_id, kind, state, stage, source_material_id, idempotency_key, request_nonce)
     values ($1, $2, $3, 'running', 'applying', $4, $5, $6)
     returning id`,
    [teamId, OWNER, action, materialId, `idem-${action}-${Date.now()}`, `nonce-${action}-1`]
  );
  const intent = await harness.root<{ id: string }>(
    `insert into private.team_material_group_intents
       (team_id, source_material_id, operation_id, action, member_snapshot, applied_member_ids, state)
     values ($1, $2, $3, $4, $5::jsonb, array[$2]::uuid[], 'running')
     returning id`,
    [
      teamId,
      materialId,
      operation[0]!.id,
      action,
      JSON.stringify([{ role: 'source', material_id: materialId }])
    ]
  );
  return intent[0]!.id;
}

async function auditRows() {
  return harness.root<{ action: string; actor_id: string; target: Record<string, string> }>(
    `select action, actor_id, target from public.team_audit_events
      where team_id = $1 and action like 'material.%' order by occurred_at`,
    [teamId]
  );
}

describe('service_complete_material_group_intent', () => {
  it('records the trash in the space history, once, under the operation actor', async () => {
    const intentId = await runningIntent('trash');
    const first = await harness.root<{ result: { state: string; reused: boolean } }>(
      'select public.service_complete_material_group_intent($1) as result',
      [intentId]
    );
    expect(first[0]!.result).toMatchObject({ state: 'succeeded', reused: false });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'material.trash', actor_id: OWNER });
    expect(rows[0]!.target.material_id).toBe(materialId);
    expect(rows[0]!.target.operation_id).toBeTruthy();

    // A repeated completion is answered from the record, not recorded again.
    const again = await harness.root<{ result: { reused: boolean } }>(
      'select public.service_complete_material_group_intent($1) as result',
      [intentId]
    );
    expect(again[0]!.result.reused).toBe(true);
    expect(await auditRows()).toHaveLength(1);
  }, 60_000);

  it('names a restore as a restore', async () => {
    const intentId = await runningIntent('restore');
    await harness.root('select public.service_complete_material_group_intent($1)', [intentId]);
    const rows = await auditRows();
    expect(rows.map(row => row.action)).toEqual(['material.trash', 'material.restore']);
  }, 60_000);
});
