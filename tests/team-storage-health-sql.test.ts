import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 011 (T069): one storage-health value per space, in the priority the
 * contract fixes — attention > disconnected > waiting > indexing > preparing >
 * connected — read from the tables as they already are.
 */

const OWNER = '21000000-0000-4000-8000-000000000001';
const VIEWER = '21000000-0000-4000-8000-000000000002';
const STRANGER = '21000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@health.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@health.test', displayName: 'Viewer' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@health.test',
    displayName: 'Stranger'
  });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function makeSpace(
  name: string,
  connect = true
): Promise<{ teamId: string; connectionId: string | null }> {
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
  if (!connect) return { teamId, connectionId: null };
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ($1, $2, 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $3)
     returning id`,
    [`perm-${teamId}`, 'owner@health.test', OWNER]
  );
  const connection = await harness.root<{ id: string }>(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state,
        initial_sync_state, connected_at)
     values ($1, $2, 'root-folder', 'Root', 'my_drive', 'connected', 'ready', now())
     returning id`,
    [teamId, credential[0]!.id]
  );
  return { teamId, connectionId: connection[0]!.id };
}

async function health(teamId: string, as = VIEWER): Promise<Record<string, unknown>> {
  const rows = await harness.asUser<{ health: Record<string, unknown> }>(
    as,
    'select public.get_team_storage_health($1) as health',
    [teamId]
  );
  return rows[0]!.health;
}

async function addMaterial(
  teamId: string,
  connectionId: string,
  input: { id: string; kind: 'folder' | 'image'; indexed?: boolean; thumb?: string }
) {
  await harness.root(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category,
        mime_type, lifecycle, folder_indexed_at, provider_thumbnail_state)
     values ($1, $2, $3, 'root-folder', $3, $4, $5, $6, 'active', $7, $8)`,
    [
      teamId,
      connectionId,
      input.id,
      input.kind === 'folder' ? 'folder' : 'file',
      input.kind === 'folder' ? null : 'image',
      input.kind === 'folder' ? 'application/vnd.google-apps.folder' : 'image/png',
      input.kind === 'folder' && input.indexed ? new Date().toISOString() : null,
      input.thumb ?? 'none'
    ]
  );
  // The index trigger starts every eligible file at `pending`; a ready
  // thumbnail is what the warm worker commits, version-matched to the file.
  if (input.thumb === 'ready') {
    await harness.root(
      `update public.team_materials set drive_version = '1' where team_id = $1 and drive_file_id = $2`,
      [teamId, input.id]
    );
    await harness.root(
      `update public.team_materials
         set provider_thumbnail_state = 'ready', provider_thumbnail_version = '1'
       where team_id = $1 and drive_file_id = $2`,
      [teamId, input.id]
    );
  }
}

describe('get_team_storage_health', () => {
  it('is disconnected without a connection and refuses strangers', async () => {
    const { teamId } = await makeSpace('Health none', false);
    expect(await health(teamId)).toEqual({ kind: 'disconnected' });
    await expect(health(teamId, STRANGER)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('is connected when nothing is pending, stamped with the last reconciliation', async () => {
    const { teamId } = await makeSpace('Health ready');
    const value = await health(teamId);
    expect(value.kind).toBe('connected');
    expect(typeof value.lastReconciledAt).toBe('string');
  });

  it('stops claiming progress when the scan has stopped moving', async () => {
    // Found in the beta run: a queued job whose worker never ran left the chip
    // spinning "Indexing…" with nothing to act on, for as long as anyone
    // watched it.
    const { teamId, connectionId } = await makeSpace('Health stalled');
    await addMaterial(teamId, connectionId!, { id: 'f9', kind: 'folder' });
    await harness.root(
      `update public.team_drive_connections set initial_sync_state = 'scanning' where id = $1`,
      [connectionId]
    );
    await harness.root(
      `insert into private.catalog_sync_jobs (connection_id, phase, state, updated_at)
       values ($1, 'initial_scan', 'pending', clock_timestamp() - interval '40 minutes')`,
      [connectionId]
    );
    expect(await health(teamId)).toEqual({
      kind: 'attention',
      reason: 'sync_failed',
      fixer: 'manager'
    });

    // A job that is being worked on right now still reads as indexing.
    await harness.root(
      `update private.catalog_sync_jobs set updated_at = clock_timestamp() where connection_id = $1`,
      [connectionId]
    );
    expect((await health(teamId)).kind).toBe('indexing');
  });

  it('is indexing while any folder has not been listed', async () => {
    const { teamId, connectionId } = await makeSpace('Health indexing');
    await harness.root(
      `insert into private.catalog_sync_jobs (connection_id, phase, state, updated_at)
       values ($1, 'initial_scan', 'pending', clock_timestamp())`,
      [connectionId]
    );
    await addMaterial(teamId, connectionId!, { id: 'f1', kind: 'folder', indexed: true });
    await addMaterial(teamId, connectionId!, { id: 'f2', kind: 'folder' });
    await addMaterial(teamId, connectionId!, { id: 'i1', kind: 'image', thumb: 'pending' });
    expect(await health(teamId)).toEqual({
      kind: 'indexing',
      indexedFolders: 1,
      totalFolders: 2,
      files: 1
    });
  });

  it('is preparing once folders are listed but thumbnails are still pending', async () => {
    const { teamId, connectionId } = await makeSpace('Health preparing');
    await addMaterial(teamId, connectionId!, { id: 'f1', kind: 'folder', indexed: true });
    await addMaterial(teamId, connectionId!, { id: 'i1', kind: 'image', thumb: 'ready' });
    await addMaterial(teamId, connectionId!, { id: 'i2', kind: 'image', thumb: 'pending' });
    expect(await health(teamId)).toEqual({ kind: 'preparing', ready: 1, pending: 1 });
  });

  it('waits for the provider while a sync job is backing off on a provider code', async () => {
    const { teamId, connectionId } = await makeSpace('Health waiting');
    await harness.root(
      `insert into private.catalog_sync_jobs (connection_id, phase, state, last_error_code, updated_at)
       values ($1, 'initial_scan', 'retry', 'RATE_LIMITED', now())`,
      [connectionId]
    );
    const value = await health(teamId);
    expect(value.kind).toBe('waiting_provider');
    expect(typeof value.since).toBe('string');
  });

  it('needs attention ahead of everything else, naming who can fix it', async () => {
    const { teamId, connectionId } = await makeSpace('Health attention');
    await addMaterial(teamId, connectionId!, { id: 'f2', kind: 'folder' });
    await harness.root(
      `update public.team_drive_connections set state = 'needs_reauth' where id = $1`,
      [connectionId]
    );
    expect(await health(teamId)).toEqual({
      kind: 'attention',
      reason: 'needs_reauth',
      fixer: 'owner'
    });
    await harness.root(
      `update public.team_drive_connections set state = 'connected', initial_sync_state = 'failed'
       where id = $1`,
      [connectionId]
    );
    expect(await health(teamId)).toEqual({
      kind: 'attention',
      reason: 'sync_failed',
      fixer: 'manager'
    });
  });
});
