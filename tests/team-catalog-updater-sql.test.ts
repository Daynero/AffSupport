import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 023: the catalog updater in the database — who may run it, how a round opens once however
 * late it is, how the worker's leases keep two invocations off the same sheet, and why a sheet's
 * update count outlives its time in the updater.
 */

const OWNER = '23000000-0000-4000-8000-000000000001';
const VIEWER = '23000000-0000-4000-8000-000000000002';
const OTHER = '23000000-0000-4000-8000-000000000003';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let harness: TeamTestDb;
let teamId: string;
let otherTeamId: string;
let connectionId: string;
const connections = new Map<string, string>();
let seq = 0;

interface State {
  state: 'running' | 'stopped';
  interval: string;
  nextRunAt: string | null;
  catalogCount: number;
  failingCount: number;
  serverNow: string;
}

async function material(
  team: string,
  name: string,
  category: string | null,
  mime: string,
  extra: Record<string, string | null> = {}
): Promise<string> {
  seq += 1;
  const rows = await harness.root<{ id: string }>(
    `insert into public.team_materials
       (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      team,
      connections.get(team),
      extra.driveFileId ?? `drive-${seq}`,
      extra.parent ?? 'root',
      name,
      extra.kind ?? 'file',
      category,
      mime
    ]
  );
  return rows[0]!.id;
}

/** A live 022 catalog: a video, its sheet, linked through the 022 service function. */
async function catalog(name: string, team = teamId) {
  const video = await material(team, `${name}.mp4`, 'video', 'video/mp4', { parent: 'folder-a' });
  const sheet = await material(team, `${name} catalog`, 'other', SHEET_MIME, {
    parent: 'folder-a'
  });
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
  const linked = await harness.root<{ result: { linked: boolean } }>(
    'select public.service_link_product_catalog_companion($1, $2, $3, null, $4) as result',
    [team, video, sheet, JSON.stringify(record)]
  );
  expect(linked[0]!.result.linked).toBe(true);
  return { video, sheet };
}

const state = async (as = OWNER) =>
  (
    await harness.asUser<{ result: State }>(
      as,
      'select public.get_team_catalog_updater($1) as result',
      [teamId]
    )
  )[0]!.result;

async function save(catalogs: string[], interval = '1h', restitch = false, as = OWNER) {
  const rows = await harness.asUser<{ result: State }>(
    as,
    'select public.save_team_catalog_updater($1, $2, $3, $4) as result',
    [teamId, catalogs, interval, restitch]
  );
  return rows[0]!.result;
}

const stop = (as = OWNER) =>
  harness.asUser(as, 'select public.stop_team_catalog_updater($1)', [teamId]);

const openRounds = async () =>
  (
    await harness.root<{ n: number }>('select public.service_open_catalog_updater_rounds() as n')
  )[0]!.n;

const claim = (worker: string, limit = 10, lease = 60) =>
  harness.root<{ catalog_material_id: string; update_count: number; credential_id: string }>(
    'select * from public.service_claim_catalog_updater_items($1, $2, $3)',
    [worker, limit, lease]
  );

const complete = async (item: string, worker: string, count: number) =>
  (
    await harness.root<{ ok: boolean }>(
      'select public.service_complete_catalog_update($1, $2, $3) as ok',
      [item, worker, count]
    )
  )[0]!.ok;

const makeDue = () =>
  harness.root(
    `update public.team_catalog_updaters set next_run_at = now() - interval '5 hours' where team_id = $1`,
    [teamId]
  );

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@updater.test', displayName: 'Owner' });
  await createUser(harness, { id: VIEWER, email: 'viewer@updater.test', displayName: 'Viewer' });
  await createUser(harness, { id: OTHER, email: 'other@updater.test', displayName: 'Other' });
  await harness.root(`insert into public.admin_users (user_id) values ($1), ($2)`, [OWNER, OTHER]);
  teamId = (
    await harness.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', [
      'Updater'
    ])
  )[0]!.id;
  otherTeamId = (
    await harness.asUser<{ id: string }>(OTHER, 'select id from public.create_team($1)', ['Other'])
  )[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-updater', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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
  connections.set(teamId, connectionId);
  const otherCredential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-other', 'other@example.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $1)
     returning id`,
    [OTHER]
  );
  connections.set(
    otherTeamId,
    (
      await harness.root<{ id: string }>(
        `insert into public.team_drive_connections
           (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
         values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
         returning id`,
        [otherTeamId, otherCredential[0]!.id]
      )
    )[0]!.id
  );
  await material(teamId, 'Offers', null, 'application/vnd.google-apps.folder', {
    driveFileId: 'folder-a',
    kind: 'folder'
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('the registry', () => {
  it('lists live catalogs with their folder and counters, and hides a catalog whose video is gone', async () => {
    const kept = await catalog('kept');
    const lost = await catalog('lost');
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [lost.video]
    );
    const rows = await harness.asUser<{
      catalog_id: string;
      video_name: string;
      folder_name: string;
      update_count: number;
      in_updater: boolean;
    }>(VIEWER, 'select * from public.list_team_product_catalogs($1)', [teamId]);
    const ids = rows.map(row => row.catalog_id);
    expect(ids).toContain(kept.sheet);
    expect(ids).not.toContain(lost.sheet);
    expect(rows.find(row => row.catalog_id === kept.sheet)).toMatchObject({
      video_name: 'kept.mp4',
      folder_name: 'Offers',
      update_count: 0,
      in_updater: false
    });
  }, 60_000);

  it('is not readable from outside the space', async () => {
    await expect(
      harness.asUser(OTHER, 'select * from public.list_team_product_catalogs($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  }, 60_000);
});

describe('saving and stopping', () => {
  it('reads as stopped before anyone starts it', async () => {
    expect(await state(VIEWER)).toMatchObject({
      state: 'stopped',
      nextRunAt: null,
      catalogCount: 0
    });
  }, 60_000);

  it('refuses a viewer, an empty list, a foreign catalog and a strange interval', async () => {
    const { sheet } = await catalog('refusals');
    const foreign = await catalog('foreign', otherTeamId);
    await expect(save([sheet], '1h', false, VIEWER)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(save([])).rejects.toThrow(/INVALID_INPUT/);
    await expect(save([foreign.sheet])).rejects.toThrow(/INVALID_INPUT/);
    await expect(save([sheet], '2h')).rejects.toThrow(/INVALID_INPUT/);
  }, 60_000);

  it('starts one interval ahead, keeps the due time when only the list changes, resets it on a new interval', async () => {
    const a = await catalog('start-a');
    const b = await catalog('start-b');
    const started = await save([a.sheet], '1h');
    expect(started.state).toBe('running');
    const ahead = Date.parse(started.nextRunAt!) - Date.parse(started.serverNow);
    expect(ahead).toBeGreaterThan(3_590_000);
    expect(ahead).toBeLessThanOrEqual(3_600_500);

    const listChanged = await save([a.sheet, b.sheet], '1h');
    expect(listChanged.nextRunAt).toBe(started.nextRunAt);
    expect(listChanged.catalogCount).toBe(2);

    const intervalChanged = await save([a.sheet, b.sheet], '1d');
    expect(
      Date.parse(intervalChanged.nextRunAt!) - Date.parse(intervalChanged.serverNow)
    ).toBeGreaterThan(86_000_000);
  }, 60_000);

  it('stops: no due time, no catalogs', async () => {
    await stop();
    expect(await state()).toMatchObject({ state: 'stopped', nextRunAt: null, catalogCount: 0 });
  }, 60_000);
});

describe('rounds and leases', () => {
  it('opens one round however overdue, and moves the next run one interval from now', async () => {
    const { sheet } = await catalog('round');
    await save([sheet], '1h');
    await makeDue();
    expect(await openRounds()).toBe(1);
    expect(await openRounds()).toBe(0);
    const after = await state();
    expect(Date.parse(after.nextRunAt!) - Date.parse(after.serverNow)).toBeGreaterThan(3_590_000);
    await stop();
  }, 60_000);

  it('lets one worker hold a sheet, completes one step, and refuses a lost lease', async () => {
    const { sheet } = await catalog('lease');
    await save([sheet], '1h');
    await makeDue();
    await openRounds();

    const first = await claim('worker-1');
    expect(first.map(row => row.catalog_material_id)).toEqual([sheet]);
    expect(first[0]).toMatchObject({ update_count: 0 });
    expect(await claim('worker-2')).toHaveLength(0);

    expect(await complete(sheet, 'worker-2', 1)).toBe(false);
    expect(await complete(sheet, 'worker-1', 1)).toBe(true);
    // A completion replayed after it counted must not push the count past the sheet's IDs.
    await harness.root(
      `update public.team_catalog_updater_items set lease_owner = 'worker-1', lease_expires_at = now() + interval '1 minute' where catalog_material_id = $1`,
      [sheet]
    );
    expect(await complete(sheet, 'worker-1', 3)).toBe(true);
    const counted = await harness.root<{ update_count: number }>(
      'select update_count from public.team_product_catalogs where material_id = $1',
      [sheet]
    );
    expect(counted[0]!.update_count).toBe(1);
    expect(await claim('worker-1')).toHaveLength(0);
    await stop();
  }, 60_000);

  it('lets an expired lease be claimed again', async () => {
    const { sheet } = await catalog('expired');
    await save([sheet], '1h');
    await makeDue();
    await openRounds();
    await claim('worker-1');
    await harness.root(
      `update public.team_catalog_updater_items set lease_expires_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second' where catalog_material_id = $1`,
      [sheet]
    );
    expect((await claim('worker-2')).map(row => row.catalog_material_id)).toEqual([sheet]);
    await stop();
  }, 60_000);

  it('records a failure after three attempts and backs off', async () => {
    const { sheet } = await catalog('failing');
    await save([sheet], '1h');
    await makeDue();
    await openRounds();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await harness.root(
        `update public.team_catalog_updater_items set next_attempt_at = now() - interval '1 second' where catalog_material_id = $1`,
        [sheet]
      );
      expect(await claim(`w-${attempt}`)).toHaveLength(1);
      const retried = await harness.root<{ ok: boolean }>(
        `select public.service_retry_catalog_update($1, $2, 'DRIVE_UNAVAILABLE', now() + interval '1 minute') as ok`,
        [sheet, `w-${attempt}`]
      );
      expect(retried[0]!.ok).toBe(true);
    }
    const rows = await harness.asUser<{ last_update_error: string | null }>(
      OWNER,
      'select last_update_error from public.list_team_product_catalogs($1) where catalog_id = $2',
      [teamId, sheet]
    );
    expect(rows[0]!.last_update_error).toBe('DRIVE_UNAVAILABLE');
    expect((await state()).failingCount).toBe(1);
    expect(await claim('w-4')).toHaveLength(0); // backing off
    await stop();
  }, 60_000);

  it('keeps a sheet’s count when it leaves the updater and comes back', async () => {
    const { sheet } = await catalog('rejoin');
    await save([sheet], '1h');
    await makeDue();
    await openRounds();
    await claim('w-rejoin');
    expect(await complete(sheet, 'w-rejoin', 1)).toBe(true);
    await stop();
    await save([sheet], '1h');
    await makeDue();
    await openRounds();
    const again = await claim('w-rejoin-2');
    expect(again[0]).toMatchObject({ catalog_material_id: sheet, update_count: 1 });
    await stop();
  }, 60_000);

  it('drops a catalog whose sheet is gone when its round comes', async () => {
    const { sheet } = await catalog('gone');
    await save([sheet], '1h');
    await harness.root(
      `update public.team_materials set lifecycle = 'trashed', trashed_at = now() where id = $1`,
      [sheet]
    );
    await makeDue();
    await openRounds();
    expect(await claim('w-gone')).toHaveLength(0);
    expect((await state()).catalogCount).toBe(0);
    await stop();
  }, 60_000);
});

describe('the worker’s address and grants', () => {
  it('derives the updater URL from the catalog-sync URL, and nothing else', async () => {
    const derive = async (url: string) =>
      (
        await harness.root<{ endpoint: string | null }>(
          'select private.catalog_updater_endpoint($1) as endpoint',
          [url]
        )
      )[0]!.endpoint;
    expect(await derive('http://kong:8000/functions/v1/catalog-sync')).toBe(
      'http://kong:8000/functions/v1/catalog-updater'
    );
    expect(await derive('https://abc.supabase.co/functions/v1/catalog-sync')).toBe(
      'https://abc.supabase.co/functions/v1/catalog-updater'
    );
    expect(await derive('https://abc.supabase.co/functions/v1/preview-warm')).toBeNull();
    expect(await derive('ftp://abc/catalog-sync')).toBeNull();
  }, 60_000);

  it('keeps the service functions away from members', async () => {
    const rows = await harness.root<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.service_claim_catalog_updater_items(text, integer, integer)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.service_claim_catalog_updater_items(text, integer, integer)', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.service_claim_catalog_updater_items(text, integer, integer)', 'execute') as service`
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  }, 60_000);
});
