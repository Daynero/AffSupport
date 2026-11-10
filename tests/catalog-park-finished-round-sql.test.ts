import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * 1.4.3: when a round's attempt had already ended (e.g. 'failed' with
 * PROCESS_RESULT_UNCERTAIN) but the item still carried the round, the next claim
 * parked it with reconciliation_required and no reconciliation row, so the
 * catalog showed "Потрібна перевірка" forever. A finished round now closes.
 */
const OWNER = '47000000-0000-4000-8000-0000000000b1';
const ADMIN = '47000000-0000-4000-8000-0000000000b2';
let db: TeamTestDb;
let team: string;
const connection = randomUUID();
beforeAll(async () => {
  db = await createTeamTestDb();
  await createUser(db, { id: OWNER, email: 'owner@park-round.test' });
  await createUser(db, { id: ADMIN, email: 'admin@park-round.test' });
  await db.root('insert into public.admin_users(user_id) values($1)', [ADMIN]);
  await db.asUser(
    ADMIN,
    "select public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('owner@park-round.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(0)::integer))"
  );
  team = (
    await db.asUser<{ id: string }>(
      OWNER,
      "select id from public.create_team('Synthetic park round')"
    )
  )[0]!.id;
  const credential = randomUUID();
  await db.root(
    `insert into private.google_drive_credentials(id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
     values($1::uuid,$1::text,'owner@park-round.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),$2)`,
    [credential, OWNER]
  );
  await db.root(
    `insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
     values($1,$2,$3,'root','Root','my_drive','connected',now())`,
    [connection, team, credential]
  );
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function catalogWithRound(result: string) {
  const video = randomUUID(),
    sheet = randomUUID();
  const metadata = JSON.stringify({
    sourceLink: 'https://offer.example.invalid/',
    productCount: 3,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    videoLink: 'https://drive.google.com/file/d/synthetic/view',
    createdBy: OWNER,
    settingsSnapshot: {
      title: 'F',
      description: 'F',
      price: 1,
      imageLink: 'https://images.example.invalid/a.png'
    }
  });
  await db.root(
    `insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
     ($1::uuid,$3,$4,$1::text,'root','Video','file','video','video/mp4'),
     ($2::uuid,$3,$4,$2::text,'root','Catalog','file','other','application/vnd.google-apps.spreadsheet')`,
    [video, sheet, team, connection]
  );
  await db.root(`select public.service_link_product_catalog_companion($1,$2,$3,null,$4::jsonb)`, [
    team,
    video,
    sheet,
    metadata
  ]);
  await db.asUser(
    OWNER,
    `select public.request_team_catalog_update_command($1,$2,array[$3]::uuid[],$4)`,
    [team, randomUUID(), sheet, OWNER]
  );
  await db.root(
    `update public.team_catalog_update_attempts set result=$2::text,failure_code=case when $2::text='failed' then 'PROCESS_RESULT_UNCERTAIN' end,
       ended_at=case when $2::text<>'unknown' then clock_timestamp() end where catalog_material_id=$1::uuid`,
    [sheet, result]
  );
  await db.root(
    `update public.team_catalog_updater_items set lease_owner='park-owner',lease_expires_at=clock_timestamp()+interval '1 minute'
     where catalog_material_id=$1`,
    [sheet]
  );
  return sheet;
}
const item = async (sheet: string) =>
  (
    await db.root<{ round: string | null; quarantined: boolean; error: string | null }>(
      `select item.round_due_at::text round, coalesce(item.reconciliation_required,false) quarantined, c.last_update_error error
       from public.team_product_catalogs c left join public.team_catalog_updater_items item on item.catalog_material_id=c.material_id
       where c.material_id=$1`,
      [sheet]
    )
  )[0]!;

it('closes a round whose attempt already failed instead of stranding it', async () => {
  const sheet = await catalogWithRound('failed');
  const parked = await db.root<{ p: boolean }>(
    `select public.service_park_catalog_update_claim($1,'park-owner') p`,
    [sheet]
  );
  expect(parked[0]!.p).toBe(true);
  expect(await item(sheet)).toEqual({
    round: null,
    quarantined: false,
    error: 'PROCESS_RESULT_UNCERTAIN'
  });
});

it('still quarantines a round whose outcome is unknown', async () => {
  const sheet = await catalogWithRound('unknown');
  await db.root(`select public.service_park_catalog_update_claim($1,'park-owner')`, [sheet]);
  const state = await item(sheet);
  expect(state.quarantined).toBe(true);
  expect(state.error).toBe('CATALOG_ATTEMPT_STATE_INCONSISTENT');
});
