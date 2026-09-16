import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 023: re-stitched copies behind the catalogs, in the database — the member whose open tab
 * prepares them, one spare per catalog, jobs that appear and disappear with the updater, the swap at a
 * round, and the queue that deletes used copies for good.
 */

const OWNER = '23100000-0000-4000-8000-000000000001';
const VIEWER = '23100000-0000-4000-8000-000000000002';
const EDITOR = '23100000-0000-4000-8000-000000000003';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;
let seq = 0;

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest();
const token = () => sha(randomBytes(16));

/** A member's tab: the leases are theirs. */
interface Device {
  actor: string;
}

interface State {
  state: string;
  restitch: boolean;
  spareReadyCount: number | null;
}

interface Job {
  jobId: string;
  teamId: string;
  actorId: string;
  videoMaterialId: string;
  videoName: string;
  destinationFolderId: string | null;
  updateCount: number;
  defaults: Record<string, unknown> | null;
  prepared: Record<string, unknown> | null;
}

async function material(name: string, category: string | null, mime: string, parent = 'folder-r') {
  seq += 1;
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type,
        drive_version)
     values ($1, $2, $3, $4, $5, 'file', $6, $7, '7')
     returning id`,
    [teamId, connectionId, `drive-r-${seq}`, parent, name, category, mime]
  );
  return rows[0]!.id;
}

async function catalog(name: string) {
  const video = await material(`${name}.mp4`, 'video', 'video/mp4');
  const sheet = await material(`${name} catalog`, 'other', SHEET_MIME);
  const record = {
    sourceLink: 'https://offer.example.test/?sub=1',
    productCount: 3,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    videoLink: 'https://drive.google.com/file/d/video/view?usp=sharing',
    settingsSnapshot: {
      title: 'T',
      description: 'D',
      price: 10,
      imageLink: 'https://i.test/a.png'
    },
    createdBy: OWNER
  };
  await harness.root('select public.service_link_product_catalog_companion($1, $2, $3, null, $4)', [
    teamId,
    video,
    sheet,
    JSON.stringify(record)
  ]);
  return { video, sheet };
}

const state = async () =>
  (
    await harness.asUser<{ result: State }>(
      OWNER,
      'select public.get_team_catalog_updater($1) as result',
      [teamId]
    )
  )[0]!.result;

const enroll = (actor = OWNER): Device => ({ actor });

const save = async (catalogs: string[], restitch: boolean) =>
  (
    await harness.asUser<{ result: State }>(
      OWNER,
      'select public.save_team_catalog_updater($1, $2, $3, $4) as result',
      [teamId, catalogs, '1h', restitch]
    )
  )[0]!.result;

const stop = () => harness.asUser(OWNER, 'select public.stop_team_catalog_updater($1)', [teamId]);

async function claimJob(device: Device, lease: Buffer) {
  const rows = await harness.root<{ job: Job | null }>(
    'select public.service_claim_restitch_job($1, $2, $3, 120) as job',
    [teamId, device.actor, lease]
  );
  return rows[0]!.job;
}

const jobs = (catalogId?: string) =>
  harness.root<{
    catalog_material_id: string;
    state: string;
    attempts: number;
    last_error_code: string | null;
    next_attempt_at: string;
  }>(
    `select * from private.catalog_restitch_jobs where team_id = $1
       and ($2::uuid is null or catalog_material_id = $2)`,
    [teamId, catalogId ?? null]
  );

const copies = (catalogId: string) =>
  harness.root<{
    material_id: string;
    role: string;
    shared_link: string | null;
    next_delete_at: string | null;
  }>(
    `select * from public.team_catalog_restitch_copies where catalog_material_id = $1
     order by created_at`,
    [catalogId]
  );

async function operation(catalogId: string) {
  const operationId = (await harness.root<{ id: string }>('select gen_random_uuid() as id'))[0]!.id;
  return { operationId, catalogId };
}

const bind = async (job: string, lease: Buffer, operationId: string) =>
  (
    await harness.root<{ ok: boolean }>(
      'select public.service_bind_restitch_job_operation($1, $2, $3) as ok',
      [job, lease, operationId]
    )
  )[0]!.ok;

async function output(
  operationId: string,
  link: string | null = 'https://drive.google.com/file/d/copy/view'
) {
  const copy = await material('copy.mp4', 'video', 'video/mp4');
  const rows = await harness.root<{ result: string }>(
    'select public.service_record_restitch_output($1, $2, $3, $4) as result',
    [operationId, copy, `drive-of-${copy}`, link]
  );
  return { copy, result: rows[0]!.result };
}

/** Claims the catalog's job, binds an operation and commits its output as the spare. */
async function prepareSpare(device: Device, catalogId: string, link: string) {
  const lease = token();
  const job = await claimJob(device, lease);
  expect(job?.jobId).toBe(catalogId);
  const { operationId } = await operation(catalogId);
  expect(await bind(catalogId, lease, operationId)).toBe(true);
  const made = await output(operationId, link);
  expect(made.result).toBe('spare');
  return made.copy;
}

async function round(catalogId: string) {
  await harness.root(
    `update public.team_catalog_updater_items set next_run_at = now() - interval '1 minute'
     where team_id = $1 and update_interval is not null`,
    [teamId]
  );
  await harness.root('select public.service_open_catalog_updater_rounds()');
  const claimed = await harness.root<{
    catalog_material_id: string;
    update_count: number;
    current_video_link: string | null;
    spare_material_id: string | null;
    spare_link: string | null;
  }>('select * from public.service_claim_catalog_updater_items($1, 10, 60)', ['worker-r']);
  const item = claimed.find(row => row.catalog_material_id === catalogId)!;
  expect(item).toBeTruthy();
  return item;
}

const completeRound = async (catalogId: string, count: number, copy: string | null) =>
  (
    await harness.root<{ ok: boolean }>(
      'select public.service_complete_catalog_update($1, $2, $3, $4) as ok',
      [catalogId, 'worker-r', count, copy]
    )
  )[0]!.ok;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@restitch.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@restitch.test', displayName: 'Viewer' });
  await createUser(harness, { id: EDITOR, email: 'editor@restitch.test', displayName: 'Editor' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
  teamId = (
    await harness.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', [
      'Restitch'
    ])
  )[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer'), ($1, $3, 'admin')`,
    [teamId, VIEWER, EDITOR]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-restitch', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OWNER]
  );
  connectionId = (
    await harness.root<{ id: string }>(
      `insert into public.team_drive_connections
         (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
       values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
       returning id`,
      [teamId, credential[0]!.id]
    )
  )[0]!.id;
  seq += 1;
  await harness.root(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values ($1, $2, 'folder-r', 'root', 'Offers', 'folder', null, 'application/vnd.google-apps.folder')`,
    [teamId, connectionId]
  );
  await harness.root(
    `insert into public.team_restitch_defaults
       (team_id, operation, start_image_ids, configured)
     values ($1, 'restitch', array[gen_random_uuid()], true)`,
    [teamId]
  );
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('who prepares', () => {
  it('refuses a member who cannot process, and one who no longer can', async () => {
    await expect(claimJob(enroll(VIEWER), token())).rejects.toThrow(/PERMISSION_DENIED/);
    const editor = enroll(EDITOR);
    expect(await claimJob(editor, token())).toBeNull();
    await harness.root(
      `update public.team_members set base_role = 'viewer' where team_id = $1 and user_id = $2`,
      [teamId, EDITOR]
    );
    await expect(claimJob(editor, token())).rejects.toThrow(/PERMISSION_DENIED/);
    await harness.root(
      `update public.team_members set base_role = 'admin' where team_id = $1 and user_id = $2`,
      [teamId, EDITOR]
    );
  }, 60_000);
});

describe('spares', () => {
  it('queues one job per catalog when re-stitching is on, and none when it is off', async () => {
    const a = await catalog('turn-on-a');
    const b = await catalog('turn-on-b');
    expect(await save([a.sheet, b.sheet], false)).toMatchObject({
      restitch: false,
      spareReadyCount: null
    });
    expect(await jobs()).toHaveLength(0);
    const saved = await save([a.sheet, b.sheet], true);
    expect(saved).toMatchObject({ restitch: true, spareReadyCount: 0 });
    expect((await jobs()).map(job => job.catalog_material_id).sort()).toEqual(
      [a.sheet, b.sheet].sort()
    );
    await save([a.sheet, b.sheet], false);
    expect(await jobs()).toHaveLength(0);
    await stop();
  }, 60_000);

  it('hands the job out once, with the video, its folder and the space defaults', async () => {
    const { sheet, video } = await catalog('claim');
    const device = enroll();
    await save([sheet], true);
    const lease = token();
    const job = await claimJob(device, lease);
    expect(job).toMatchObject({
      jobId: sheet,
      teamId,
      actorId: OWNER,
      videoMaterialId: video,
      videoName: 'claim.mp4',
      updateCount: 0
    });
    expect(job!.destinationFolderId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(job!.defaults).toMatchObject({ operation: 'restitch', configured: true });
    expect(await claimJob(device, token())).toBeNull(); // one at a time per member
    expect(await bind(sheet, token(), (await operation(sheet)).operationId)).toBe(false);
    await stop();
  }, 60_000);

  it('records the output as the spare, and only one spare per catalog', async () => {
    const { sheet } = await catalog('spare');
    const device = enroll();
    await save([sheet], true);
    const copy = await prepareSpare(device, sheet, 'https://drive.google.com/file/d/s1/view');
    expect(await copies(sheet)).toMatchObject([{ material_id: copy, role: 'spare' }]);
    expect(await jobs(sheet)).toHaveLength(0);
    expect((await state()).spareReadyCount).toBe(1);
    expect(await claimJob(device, token())).toBeNull();

    const stranger = await output((await operation(sheet)).operationId);
    expect(stranger.result).toBe('none');
    await stop();
  }, 60_000);

  it('renews the lease while wanted and says stop once the updater stops', async () => {
    const { sheet } = await catalog('heartbeat');
    const device = enroll();
    await save([sheet], true);
    const lease = token();
    await claimJob(device, lease);
    const beat = async () =>
      (
        await harness.root<{ cancel: boolean }>(
          'select public.service_heartbeat_restitch_job($1, $2, $3, 120) as cancel',
          [device.actor, sheet, lease]
        )
      )[0]!.cancel;
    expect(await beat()).toBe(false);
    const { operationId } = await operation(sheet);
    await bind(sheet, lease, operationId);
    await stop();
    expect(await beat()).toBe(true);
    // The run finished anyway: its copy is not a spare but queued for deletion.
    const late = await output(operationId);
    expect(late.result).toBe('retired');
    expect(await copies(sheet)).toMatchObject([{ material_id: late.copy, role: 'retired' }]);
  }, 60_000);

  it('backs a failed job off', async () => {
    const { sheet } = await catalog('failure');
    const device = enroll();
    await save([sheet], true);
    const lease = token();
    await claimJob(device, lease);
    const complete = (as: string) =>
      harness.root<{ ok: boolean }>(
        'select public.service_complete_restitch_job($1, $2, $3, $4, $5) as ok',
        [as, sheet, lease, 'failed', 'UNSUPPORTED_MEDIA']
      );
    expect((await complete(EDITOR))[0]!.ok).toBe(false); // not their lease
    expect((await complete(OWNER))[0]!.ok).toBe(true);
    const [job] = await jobs(sheet);
    expect(job).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error_code: 'UNSUPPORTED_MEDIA'
    });
    expect(Date.parse(job!.next_attempt_at) - Date.now()).toBeGreaterThan(50_000);
    await stop();
  }, 60_000);
});

describe('rounds', () => {
  it('swaps the sheet to the spare, retires the copy used before, and asks for the next spare', async () => {
    const { sheet } = await catalog('swap');
    const device = enroll();
    await save([sheet], true);
    const first = await prepareSpare(device, sheet, 'https://drive.google.com/file/d/first/view');

    const item = await round(sheet);
    expect(item).toMatchObject({
      spare_material_id: first,
      spare_link: 'https://drive.google.com/file/d/first/view',
      current_video_link: null
    });
    expect(await completeRound(sheet, item.update_count + 1, first)).toBe(true);
    expect(await copies(sheet)).toMatchObject([{ material_id: first, role: 'in_use' }]);
    const record = await harness.root<{ current_video_link: string }>(
      'select current_video_link from public.team_product_catalogs where material_id = $1',
      [sheet]
    );
    expect(record[0]!.current_video_link).toBe('https://drive.google.com/file/d/first/view');
    expect(await jobs(sheet)).toHaveLength(1);

    const second = await prepareSpare(device, sheet, 'https://drive.google.com/file/d/second/view');
    const next = await round(sheet);
    expect(next.current_video_link).toBe('https://drive.google.com/file/d/first/view');
    await completeRound(sheet, next.update_count + 1, second);
    const roles = Object.fromEntries(
      (await copies(sheet)).map(copy => [copy.material_id, copy.role])
    );
    expect(roles).toEqual({ [first]: 'retired', [second]: 'in_use' });

    // The retired copy is due at once and leaves the record, and the space, when deleted.
    const due = await harness.root<{ material_id: string }>(
      'select * from public.service_claim_retired_restitch_copies(10)'
    );
    expect(due.map(row => row.material_id)).toContain(first);
    await harness.root('select public.service_forget_restitch_copy($1, true)', [first]);
    const gone = await harness.root<{ lifecycle: string }>(
      'select lifecycle from public.team_materials where id = $1',
      [first]
    );
    expect(gone[0]!.lifecycle).toBe('missing');
    expect((await copies(sheet)).map(copy => copy.material_id)).toEqual([second]);
    await stop();
  }, 60_000);

  it('stops: jobs go, and spares wait before deletion', async () => {
    const { sheet } = await catalog('stop');
    const device = enroll();
    await save([sheet], true);
    const spare = await prepareSpare(device, sheet, 'https://drive.google.com/file/d/stop/view');
    const item = await round(sheet);
    expect(item.spare_material_id).toBe(spare);

    await stop();
    const [retired] = await copies(sheet);
    expect(retired).toMatchObject({ role: 'retired' });
    expect(Date.parse(retired!.next_delete_at!) - Date.now()).toBeGreaterThan(60_000);
    expect(await jobs(sheet)).toHaveLength(0);
  }, 60_000);

  it('brings a retired spare back when the round that used it completes', async () => {
    const { sheet } = await catalog('revive');
    const device = enroll();
    await save([sheet], true);
    const spare = await prepareSpare(device, sheet, 'https://drive.google.com/file/d/revive/view');
    const item = await round(sheet);
    // Re-stitching turned off during the round: the spare is retired, the item stays in the updater.
    await save([sheet], false);
    expect((await copies(sheet))[0]!.role).toBe('retired');
    expect(await completeRound(sheet, item.update_count + 1, spare)).toBe(true);
    expect(await copies(sheet)).toMatchObject([{ material_id: spare, role: 'in_use' }]);
    expect(await jobs(sheet)).toHaveLength(0);
    await stop();
  }, 60_000);
});
