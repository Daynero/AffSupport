import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  applyMigrationsAfter,
  createTeamTestDb,
  createUser,
  type TeamTestDb
} from './support/team-db';

/**
 * Production 2026-11-20 (DreamTeam, TR 84_v1), migration 20261222100000.
 *
 * A catalog update failed, the user ran it again, and it failed the same way. The first attempt
 * closed as failed; the later ones stayed «в роботі» for good, because the attempt was closed only
 * when the catalog's recorded error became a *different* code. The database is built as it was on
 * that day first, so the suite also shows what the migration does to an attempt already stuck.
 */
const BEFORE = '20261221190000_analytics_catalog_generations_creatives.sql';
const OWNER = '2a000000-0000-4000-8000-000000000001';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let harness: TeamTestDb;
let teamId: string;
let connectionId: string;
let seq = 0;

async function material(name: string, category: string | null, mime: string): Promise<string> {
  seq += 1;
  return (
    await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, $3, 'root', $4, 'file', $5, $6)
       returning id`,
      [teamId, connectionId, `drive-repeat-${seq}`, name, category, mime]
    )
  )[0]!.id;
}

async function catalog(name: string): Promise<string> {
  const video = await material(`${name}.mp4`, 'video', 'video/mp4');
  const sheet = await material(`${name} catalog`, 'other', SHEET_MIME);
  const linked = await harness.root<{ result: { linked: boolean } }>(
    'select public.service_link_product_catalog_companion($1, $2, $3, null, $4) as result',
    [
      teamId,
      video,
      sheet,
      JSON.stringify({
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
      })
    ]
  );
  expect(linked[0]!.result.linked).toBe(true);
  return sheet;
}

const updateNow = (sheet: string) =>
  harness.asUser(OWNER, 'select public.run_team_catalog_update_now($1, $2)', [teamId, [sheet]]);

/** One worker try that ends the way the worker ends a failed one: claim, then retry with a code. */
async function failOnce(sheet: string, worker: string, code: string) {
  await harness.root(
    `update public.team_catalog_updater_items set next_attempt_at = now() - interval '1 second'
     where catalog_material_id = $1`,
    [sheet]
  );
  const claimed = await harness.root<{ catalog_material_id: string }>(
    'select catalog_material_id from public.service_claim_catalog_updater_items($1, 10, 60)',
    [worker]
  );
  expect(claimed.map(row => row.catalog_material_id)).toContain(sheet);
  const retried = await harness.root<{ ok: boolean }>(
    `select public.service_retry_catalog_update($1, $2, $3, now() + interval '1 minute') as ok`,
    [sheet, worker, code]
  );
  expect(retried[0]!.ok).toBe(true);
}

async function fail(sheet: string, round: string, code: string, tries = 3) {
  for (let n = 1; n <= tries; n += 1) await failOnce(sheet, `${round}-${n}`, code);
}

/** What the worker does with a round whose attempt is already over: it parks the claim. */
async function park(sheet: string, worker: string) {
  await harness.root(
    `update public.team_catalog_updater_items set next_attempt_at = now() - interval '1 second'
     where catalog_material_id = $1`,
    [sheet]
  );
  await harness.root('select * from public.service_claim_catalog_updater_items($1, 10, 60)', [
    worker
  ]);
  return (
    await harness.root<{ parked: boolean }>(
      'select public.service_park_catalog_update_claim($1, $2) parked',
      [sheet, worker]
    )
  )[0]!.parked;
}

const attempts = (sheet: string) =>
  harness.root<{ result: string; failure_code: string | null; ended: boolean }>(
    `select result, failure_code, ended_at is not null as ended
     from public.team_catalog_update_attempts where catalog_material_id = $1 order by started_at`,
    [sheet]
  );

let stuck: string;

beforeAll(async () => {
  harness = await createTeamTestDb({ throughMigration: BEFORE });
  await createUser(harness, { id: OWNER, email: 'owner@repeat.test', displayName: 'Owner' });
  await harness.root('insert into public.admin_users (user_id) values ($1)', [OWNER]);
  teamId = (
    await harness.asUser<{ id: string }>(OWNER, 'select id from public.create_team($1)', ['Repeat'])
  )[0]!.id;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ('perm-repeat', 'owner@example.test', 'https://www.googleapis.com/auth/drive.file',
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

  // The day of the incident, replayed on the database as it was: the first attempt fails and is
  // closed, the round is parked, the second attempt fails with the same code — and stays open.
  stuck = await catalog('stuck-before');
  await updateNow(stuck);
  await fail(stuck, 'first', 'INVALID_RESPONSE');
  expect(await park(stuck, 'first-park')).toBe(true);
  await updateNow(stuck);
  await fail(stuck, 'second', 'INVALID_RESPONSE');
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

it('reproduces the hang on the database of the day, then closes that attempt on the next recorded error', async () => {
  expect(await attempts(stuck)).toEqual([
    { result: 'failed', failure_code: 'INVALID_RESPONSE', ended: true },
    { result: 'running', failure_code: null, ended: false }
  ]);

  await applyMigrationsAfter(harness, BEFORE);

  // Nothing is rewritten by the migration itself; the worker's next try is what closes it.
  expect((await attempts(stuck))[1]).toMatchObject({ result: 'running' });
  await failOnce(stuck, 'second-4', 'INVALID_RESPONSE');
  expect(await attempts(stuck)).toEqual([
    { result: 'failed', failure_code: 'INVALID_RESPONSE', ended: true },
    { result: 'failed', failure_code: 'INVALID_RESPONSE', ended: true }
  ]);
  // And the round can be parked like any other finished one, so the retries stop.
  expect(await park(stuck, 'second-park')).toBe(true);
}, 240_000);

it('closes every attempt that fails, however many times the same error repeats', async () => {
  const sheet = await catalog('repeats');
  for (const round of ['one', 'two', 'three']) {
    await updateNow(sheet);
    await fail(sheet, round, 'SOURCE_CHANGED');
    expect((await attempts(sheet)).at(-1)).toEqual({
      result: 'failed',
      failure_code: 'SOURCE_CHANGED',
      ended: true
    });
    expect(await park(sheet, `${round}-park`)).toBe(true);
  }
  expect(await attempts(sheet)).toHaveLength(3);
}, 120_000);

it('still gives an attempt its three tries before it is closed', async () => {
  const sheet = await catalog('patient');
  await updateNow(sheet);
  await fail(sheet, 'first', 'DRIVE_UNAVAILABLE');
  expect(await park(sheet, 'first-park')).toBe(true);

  await updateNow(sheet);
  // The catalog still shows the earlier failure; that alone must not end the new attempt.
  await fail(sheet, 'second', 'DRIVE_UNAVAILABLE', 2);
  expect((await attempts(sheet)).at(-1)).toEqual({
    result: 'running',
    failure_code: null,
    ended: false
  });
  await failOnce(sheet, 'second-3', 'DRIVE_UNAVAILABLE');
  expect((await attempts(sheet)).at(-1)).toMatchObject({ result: 'failed', ended: true });
}, 120_000);

it('leaves an older attempt whose outcome is unknown to reconciliation', async () => {
  const sheet = await catalog('unknown-before');
  await updateNow(sheet);
  await fail(sheet, 'first', 'DRIVE_UNAVAILABLE');
  expect(await park(sheet, 'first-park')).toBe(true);
  // As if that attempt's write had started and its result could not be told: 'unknown'.
  await harness.root(
    "update public.team_catalog_update_attempts set result = 'unknown', ended_at = null where catalog_material_id = $1",
    [sheet]
  );
  await updateNow(sheet);
  await fail(sheet, 'second', 'DRIVE_UNAVAILABLE');
  // Parking the finished round records the same error once more; nothing is running now, and
  // the attempt that is left open is the old one — which is not this error's to close.
  expect(await park(sheet, 'second-park')).toBe(true);
  expect(await attempts(sheet)).toEqual([
    { result: 'unknown', failure_code: 'DRIVE_UNAVAILABLE', ended: false },
    { result: 'failed', failure_code: 'DRIVE_UNAVAILABLE', ended: true }
  ]);
}, 120_000);

it('leaves an attempt that succeeds after an earlier failure to its own result', async () => {
  const sheet = await catalog('recovers');
  await updateNow(sheet);
  await fail(sheet, 'first', 'INVALID_RESPONSE');
  expect(await park(sheet, 'first-park')).toBe(true);

  await updateNow(sheet);
  await harness.root(
    `update public.team_catalog_updater_items set next_attempt_at = now() - interval '1 second'
     where catalog_material_id = $1`,
    [sheet]
  );
  await harness.root('select * from public.service_claim_catalog_updater_items($1, 10, 60)', [
    'recovers-worker'
  ]);
  expect(
    (
      await harness.root<{ ok: boolean }>(
        'select public.service_complete_catalog_update($1, $2, $3) as ok',
        [sheet, 'recovers-worker', 1]
      )
    )[0]!.ok
  ).toBe(true);
  expect(await attempts(sheet)).toEqual([
    { result: 'failed', failure_code: 'INVALID_RESPONSE', ended: true },
    { result: 'success', failure_code: null, ended: true }
  ]);
  expect(
    await harness.root(
      'select last_update_error from public.team_product_catalogs where material_id = $1',
      [sheet]
    )
  ).toEqual([{ last_update_error: null }]);
}, 120_000);
