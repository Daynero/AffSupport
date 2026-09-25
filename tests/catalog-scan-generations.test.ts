import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';
import { parseFolderSyncStatus } from '../packages/shared/src/team/transport';

let db: TeamTestDb;
let connection: string;
let team: string;
let job: string;
let epoch: number;
let generation: string;
const owner = '26200000-0000-4000-8000-000000000001';
const wireFile = (id: string, name = id, kind = 'file') => ({
  drive_file_id: id,
  name,
  kind,
  parent_folder_id: 'root',
  mime_type: kind === 'folder' ? 'application/vnd.google-apps.folder' : 'image/png',
  category: kind === 'folder' ? null : 'image',
  drive_version: '1'
});

beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: owner, email: 'scan@example.test' });
  await db.root('insert into public.admin_users(user_id) values ($1)', [owner]);
  const [createdTeam] = await db.asUser<{ id: string }>(
    owner,
    "select id from public.create_team('Scan generations')"
  );
  team = createdTeam!.id;
  const [credential] = await db.root<{ id: string }>(
    `insert into private.google_drive_credentials
    (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
    values ('scan', 'scan@example.test', 'https://www.googleapis.com/auth/drive.file', gen_random_uuid(), $1)
    returning id`,
    [owner]
  );
  const [createdConnection] = await db.root<{ id: string }>(
    `insert into public.team_drive_connections
    (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state)
    values ($1, $2, 'root', 'Root', 'my_drive', 'connected') returning id`,
    [team, credential!.id]
  );
  connection = createdConnection!.id;
  await db.root("select private.enqueue_catalog_sync($1, 'initial_scan', '{}', '[\"root\"]')", [
    connection
  ]);
  const [claim] = await db.root<{ job_id: string; lease_epoch: number }>(
    "select * from public.service_claim_catalog_sync_work('scan', 1, 180)"
  );
  job = claim!.job_id;
  epoch = claim!.lease_epoch;
  await db.root(
    `insert into public.team_materials(team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
    values ($1, $2, 'edited', 'root', 'Old name', 'file'), ($1, $2, 'absent', 'root', 'Absent', 'file')`,
    [team, connection]
  );
}, 60_000);
afterAll(async () => db?.close());

const begin = (restart = false) =>
  db.root<{ generation: string; page_token: string | null }>(
    'select * from public.service_begin_catalog_folder($1, $2, $3, $4, $5)',
    [job, 'scan', epoch, 'root', restart]
  );
const page = (files: unknown[], expected: string | null, next: string | null) =>
  db.root<{ saved: boolean }>(
    'select public.service_commit_catalog_scan_page($1, $2, $3, $4, $5, $6, $7, $8) as saved',
    [job, 'scan', epoch, generation, expected, next, JSON.stringify(files), next === null]
  );

describe('durable scan generations', () => {
  it('persists seen children and discovered folders with the page checkpoint', async () => {
    generation = (await begin())[0]!.generation;
    expect(
      await page([wireFile('first'), wireFile('child', 'Child', 'folder')], null, 'next')
    ).toEqual([{ saved: true }]);
    expect(await begin()).toEqual([{ generation, page_token: 'next' }]);
    expect(
      await db.root(
        'select drive_file_id from private.catalog_scan_seen where generation = $1 order by drive_file_id',
        [generation]
      )
    ).toEqual([{ drive_file_id: 'child' }, { drive_file_id: 'first' }]);
    expect(
      await db.root(
        "select folder_id, state from private.catalog_scan_frontier where job_id = $1 and folder_id = 'child'",
        [job]
      )
    ).toEqual([{ folder_id: 'child', state: 'queued' }]);
    expect(await page([], null, 'wrong')).toEqual([{ saved: false }]);
  });
  it('never overwrites a newer material mutation with an older provider page', async () => {
    await db.root(
      "update public.team_materials set name = 'Concurrent edit', parent_folder_id = 'moved' where connection_id = $1 and drive_file_id = 'edited'",
      [connection]
    );
    expect(await page([wireFile('edited', 'Stale provider name')], 'next', null)).toEqual([
      { saved: true }
    ]);
    expect(
      await db.root(
        "select name, parent_folder_id from public.team_materials where connection_id = $1 and drive_file_id = 'edited'",
        [connection]
      )
    ).toEqual([{ name: 'Concurrent edit', parent_folder_id: 'moved' }]);
  });
  it('preserves an upload and a deletion committed after the scan baseline', async () => {
    generation = (await begin(true))[0]!.generation;
    await db.root(
      `insert into public.team_materials(team_id, connection_id, drive_file_id, parent_folder_id, name, kind)
       values ($1,$2,'fresh-upload','root','New upload','file')`,
      [team, connection]
    );
    await db.root(
      "update public.team_materials set lifecycle = 'trashed', trashed_at = now() where connection_id = $1 and drive_file_id = 'absent'",
      [connection]
    );
    expect(
      await page([wireFile('fresh-upload', 'Old listing'), wireFile('absent')], null, null)
    ).toEqual([{ saved: true }]);
    expect(
      await db.root(
        `select drive_file_id, name, lifecycle from public.team_materials
       where connection_id = $1 and drive_file_id in ('fresh-upload','absent') order by drive_file_id`,
        [connection]
      )
    ).toEqual([
      { drive_file_id: 'absent', name: 'Absent', lifecycle: 'trashed' },
      { drive_file_id: 'fresh-upload', name: 'New upload', lifecycle: 'active' }
    ]);
    await db.root(
      "update public.team_materials set lifecycle = 'active', trashed_at = null where connection_id = $1 and drive_file_id = 'absent'",
      [connection]
    );
    generation = (await begin(true))[0]!.generation;
    expect(
      await page(
        [
          wireFile('first'),
          wireFile('child', 'Child', 'folder'),
          wireFile('fresh-upload', 'New upload')
        ],
        null,
        null
      )
    ).toEqual([{ saved: true }]);
  });
  it('uses complete pagination only to find candidates, never to delete them', async () => {
    const candidates = await db.root<{ file_id: string }>(
      'select file_id from public.service_catalog_missing_candidates($1, $2, $3, $4)',
      [job, 'scan', epoch, generation]
    );
    expect(candidates).toEqual([{ file_id: 'absent' }]);
    expect(
      await db.root(
        "select lifecycle from public.team_materials where connection_id = $1 and drive_file_id = 'absent'",
        [connection]
      )
    ).toEqual([{ lifecycle: 'active' }]);
  });
  it('isolates a rejected page-token restart from the prior generation', async () => {
    const old = generation;
    generation = (await begin(true))[0]!.generation;
    expect(generation).not.toBe(old);
    expect(
      await db.root('select drive_file_id from private.catalog_scan_seen where generation = $1', [
        generation
      ])
    ).toEqual([]);
    expect(
      await db.root(
        'select public.service_commit_catalog_scan_page($1,$2,$3,$4,null,null,$5,true) as saved',
        [job, 'scan', epoch, old, JSON.stringify([wireFile('late-old-page')])]
      )
    ).toEqual([{ saved: false }]);
  });
  it('rejects incomplete or malformed final pages without changing coverage', async () => {
    await expect(
      db.root('select public.service_commit_catalog_scan_page($1,$2,$3,$4,null,null,$5,false)', [
        job,
        'scan',
        epoch,
        generation,
        '[]'
      ])
    ).rejects.toThrow('INCOMPLETE_LISTING');
    await expect(page([{ name: 'missing ID' }], null, null)).rejects.toThrow('INVALID_INPUT');
    expect(
      await db.root('select coverage from private.catalog_scan_generations where id = $1', [
        generation
      ])
    ).toEqual([{ coverage: 'unknown' }]);
  });
  it('preserves unavailable files and refuses to report partial coverage as success', async () => {
    await page(
      [
        wireFile('first'),
        wireFile('child', 'Child', 'folder'),
        wireFile('fresh-upload', 'New upload')
      ],
      null,
      null
    );
    const [candidate] = await db.root<{ file_id: string; expected_revision: number }>(
      'select * from public.service_catalog_missing_candidates($1,$2,$3,$4)',
      [job, 'scan', epoch, generation]
    );
    expect(candidate!.file_id).toBe('absent');
    expect(
      await db.root(
        'select public.service_resolve_catalog_candidate($1,$2,$3,$4,$5,$6,$7,null) as saved',
        [
          job,
          'scan',
          epoch,
          generation,
          candidate!.file_id,
          candidate!.expected_revision,
          'unavailable'
        ]
      )
    ).toEqual([{ saved: true }]);
    expect(
      await db.root(
        "select lifecycle, missing_reason from public.team_materials where connection_id = $1 and drive_file_id = 'absent'",
        [connection]
      )
    ).toEqual([{ lifecycle: 'active', missing_reason: null }]);
    expect(
      await db.root('select coverage from private.catalog_scan_generations where id = $1', [
        generation
      ])
    ).toEqual([{ coverage: 'permission_limited' }]);
    expect(
      await db.root('select public.service_finish_catalog_folder($1,$2,$3,$4) as finished', [
        job,
        'scan',
        epoch,
        generation
      ])
    ).toEqual([{ finished: true }]);
    await expect(
      db.root(
        "select public.service_complete_catalog_sync_job(p_job => $1, p_worker => 'scan', p_epoch => $2, p_change_token => null)",
        [job, epoch]
      )
    ).rejects.toThrow('INCOMPLETE_SCAN');
  });
  it('requires provider proof and protects a candidate changed after the provider read', async () => {
    generation = (await begin(true))[0]!.generation;
    await page([wireFile('first'), wireFile('child', 'Child', 'folder')], null, null);
    const [original] = await db.root<{ id: string }>(
      "select id from public.team_materials where connection_id = $1 and drive_file_id = 'absent'",
      [connection]
    );
    const [candidate] = await db.root<{ file_id: string; expected_revision: number }>(
      'select * from public.service_catalog_missing_candidates($1,$2,$3,$4)',
      [job, 'scan', epoch, generation]
    );
    await expect(
      db.root('select public.service_resolve_catalog_candidate($1,$2,$3,$4,$5,$6,$7,null)', [
        job,
        'scan',
        epoch,
        generation,
        candidate!.file_id,
        candidate!.expected_revision,
        'trashed'
      ])
    ).rejects.toThrow('PROVIDER_PROOF_REQUIRED');
    for (const malformed of [
      { drive_file_id: candidate!.file_id, trashed: false },
      { ...wireFile(candidate!.file_id), trashed: false, name: '' },
      { ...wireFile(candidate!.file_id), trashed: false, kind: 'unknown' },
      { ...wireFile(candidate!.file_id), trashed: false, parent_folder_id: null }
    ]) {
      await expect(
        db.root('select public.service_resolve_catalog_candidate($1,$2,$3,$4,$5,$6,$7,$8)', [
          job,
          'scan',
          epoch,
          generation,
          candidate!.file_id,
          candidate!.expected_revision,
          'present',
          JSON.stringify(malformed)
        ])
      ).rejects.toThrow('PROVIDER_PROOF_REQUIRED');
    }
    expect(
      await db.root('select file_id from public.service_catalog_missing_candidates($1,$2,$3,$4)', [
        job,
        'scan',
        epoch,
        generation
      ])
    ).toContainEqual({ file_id: candidate!.file_id });
    await db.root(
      "update public.team_materials set name = 'Changed during proof', parent_folder_id = 'elsewhere' where connection_id = $1 and drive_file_id = 'absent'",
      [connection]
    );
    expect(
      await db.root(
        'select public.service_resolve_catalog_candidate($1,$2,$3,$4,$5,$6,$7,$8) as saved',
        [
          job,
          'scan',
          epoch,
          generation,
          candidate!.file_id,
          candidate!.expected_revision,
          'trashed',
          JSON.stringify({ ...wireFile('absent'), trashed: true })
        ]
      )
    ).toEqual([{ saved: true }]);
    expect(
      await db.root(
        "select id, lifecycle, name from public.team_materials where connection_id = $1 and drive_file_id = 'absent'",
        [connection]
      )
    ).toEqual([{ id: original!.id, lifecycle: 'active', name: 'Changed during proof' }]);
  });
  it('keeps a frontier wider than 10,000 folders durable while returning at most 100', async () => {
    await db.root(
      `insert into private.catalog_scan_frontier(job_id, folder_id)
      select $1, 'wide-' || n from generate_series(1, 10100) n`,
      [job]
    );
    expect(
      await db.root(
        'select count(*)::int as count from public.service_catalog_scan_frontier($1,$2,$3)',
        [job, 'scan', epoch]
      )
    ).toEqual([{ count: 100 }]);
    expect(
      await db.root(
        "select count(*)::int as count from private.catalog_scan_frontier where job_id = $1 and folder_id like 'wide-%'",
        [job]
      )
    ).toEqual([{ count: 10100 }]);
  });
  it('exposes only the safe status projection to current members', async () => {
    await db.root(
      "update private.catalog_sync_jobs set requested_folder_id = 'root' where id = $1",
      [job]
    );
    const [row] = await db.asUser<{ status: unknown }>(
      owner,
      'select public.get_team_folder_sync_status($1,$2) as status',
      [team, job]
    );
    expect(parseFolderSyncStatus(row!.status)).toMatchObject({
      jobId: job,
      scopeFolderId: 'root',
      state: 'running'
    });
    await expect(
      db.asUser(
        '26200000-0000-4000-8000-000000000099',
        'select public.get_team_folder_sync_status($1,$2)',
        [team, job]
      )
    ).rejects.toThrow('PERMISSION_DENIED');
  });
  it('refuses every staging mutation from an expired worker', async () => {
    await db.root(
      "update private.catalog_sync_jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [job]
    );
    expect(await begin(true)).toEqual([]);
    expect(await page([wireFile('expired-worker')], null, null)).toEqual([{ saved: false }]);
    expect(
      await db.root('select public.service_finish_catalog_folder($1,$2,$3,$4) as finished', [
        job,
        'scan',
        epoch,
        generation
      ])
    ).toEqual([{ finished: false }]);
    expect(
      await db.root(
        "select drive_file_id from public.team_materials where drive_file_id = 'expired-worker'"
      )
    ).toEqual([]);
  });
});
