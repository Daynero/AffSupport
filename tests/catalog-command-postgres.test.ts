import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';

// Only the acceptance runner's disposable clone, never a beta/source database.
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  team = randomUUID();
async function sql(statement: string): Promise<string> {
  assertDisposablePostgresContainer(container);
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      '-d',
      'postgres'
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024 }
  );
  const result = new Promise<string>((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout!.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr!.on('data', chunk => {
      error = (error + String(chunk)).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error(error))));
  });
  child.stdin!.end(statement);
  return result;
}
async function held(marker: string, event = 'PgSleep') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
    and pid<>pg_backend_pid() and query like '%${marker}%' and ${event === 'Lock' ? "wait_event_type='Lock'" : "wait_event='PgSleep'"}`)) ===
      '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `isolated transaction ${marker} ${event}` }
  );
}

const connection = randomUUID();
async function fixture() {
  const video = randomUUID(),
    sheet = randomUUID();
  const metadata = JSON.stringify({
    sourceLink: 'https://offer.example.invalid/',
    productCount: 3,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    videoLink: 'https://drive.google.com/file/d/synthetic/view',
    createdBy: owner,
    settingsSnapshot: {
      title: 'Fixture',
      description: 'Fixture',
      price: 1,
      imageLink: 'https://images.example.invalid/a.png'
    }
  });
  await sql(`begin;
    insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type) values
      ('${video}','${team}','${connection}','${video}','root','Video','file','video','video/mp4'),
      ('${sheet}','${team}','${connection}','${sheet}','root','Catalog','file','other','application/vnd.google-apps.spreadsheet');
    select public.service_link_product_catalog_companion('${team}','${video}','${sheet}',null,'${metadata}'::jsonb);commit;`);
  return sheet;
}
const request = (command: string, sheet: string) =>
  `select public.request_team_catalog_update_command('${team}','${command}',array['${sheet}']::uuid[],'${owner}')`;
const cancel = (command: string, sheet: string) =>
  `select public.cancel_team_catalog_command_intent('${team}','${command}',array['${sheet}']::uuid[],'${owner}')`;
const asActor = (statement: string) =>
  `begin;select set_config('request.jwt.claim.sub','${owner}',true);set local role authenticated;${statement};commit;`;
const receipt = (text: string) => JSON.parse(text.split('\n').find(line => line.startsWith('{'))!);
const count = (sheet: string) =>
  sql(
    `select count(*) from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
  );
describe.skipIf(!container)(
  '047 command acceptance [needs: disposable PostgreSQL container]',
  () => {
    beforeAll(async () => {
      const credential = randomUUID();
      await sql(`begin;
      insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
        values('${owner}','authenticated','authenticated','${owner}@command-race.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      insert into public.teams(id,name,owner_id) values('${team}','Synthetic command race','${owner}');
      insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
      insert into private.google_drive_credentials(id,google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
        values('${credential}','${credential}','${owner}@command-race.test.invalid','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),'${owner}');
      insert into public.team_drive_connections(id,team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
        values('${connection}','${team}','${credential}','root','Root','my_drive','connected',now());commit;`);
    });
    it('serializes replay of the same request key while the first acceptance is uncommitted', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_accept_hold */`)
      );
      await held('command_accept_hold');
      const second = sql(asActor(`${request(command, sheet)} /* command_replay_wait */`));
      await held('command_replay_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
      expect(await count(sheet)).toBe('1');
    }, 15000);
    it('lets a cancellation tombstone win before a delayed request arrives', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${cancel(command, sheet)};select pg_sleep(2) /* command_cancel_hold */`)
      );
      await held('command_cancel_hold');
      const second = sql(asActor(`${request(command, sheet)} /* command_late_wait */`));
      await held('command_late_wait', 'Lock');
      const result = receipt(await second);
      expect(result).toEqual(receipt(await first));
      expect(result.status).toBe('cancelled');
      expect(await count(sheet)).toBe('0');
    }, 15000);
    it('returns acceptance when cancellation loses the race and leaves the accepted run intact', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_first_hold */`)
      );
      await held('command_first_hold');
      const second = sql(asActor(`${cancel(command, sheet)} /* command_cancel_wait */`));
      await held('command_cancel_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
      expect(await count(sheet)).toBe('1');
      expect(
        await sql(
          `select round_due_at is not null from public.team_catalog_updater_items where catalog_material_id='${sheet}'`
        )
      ).toBe('t');
    }, 15000);
    it('serializes different commands for the same catalog without binding another accepted attempt', async () => {
      const sheet = await fixture(),
        command = randomUUID(),
        other = randomUUID();
      const first = sql(
        asActor(`${request(command, sheet)};select pg_sleep(2) /* command_parent_hold */`)
      );
      await held('command_parent_hold');
      const second = sql(asActor(`${request(other, sheet)} /* command_parent_wait */`));
      await held('command_parent_wait', 'Lock');
      const result = receipt(await second),
        initial = receipt(await first);
      expect(initial.acceptedCount).toBe(1);
      expect(result.acceptedCount).toBe(0);
      expect(result.items[0].reason).toBe('already_pending');
      expect(await count(sheet)).toBe('1');
      expect(
        await sql(
          `select command_id from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
        )
      ).toBe(command);
    }, 15000);
    it('does not quarantine a replacement lease after waiting for its item lock', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      await sql(asActor(request(command, sheet)));
      await sql(`update public.team_catalog_update_attempts set result='failed',ended_at=clock_timestamp() where catalog_material_id='${sheet}';
        update public.team_catalog_updater_items set lease_owner='old-claim',lease_expires_at=clock_timestamp()+interval '1 minute' where catalog_material_id='${sheet}';`);
      const replacement = sql(
        `begin;update public.team_catalog_updater_items set lease_owner='new-claim' where catalog_material_id='${sheet}';select pg_sleep(2) /* claim_replacement_hold */;commit;`
      );
      await held('claim_replacement_hold');
      const park = sql(
        `select public.service_park_catalog_update_claim('${sheet}','old-claim') /* claim_replacement_wait */`
      );
      await held('claim_replacement_wait', 'Lock');
      await replacement;
      expect(await park).toBe('f');
      expect(
        await sql(
          `select lease_owner||':'||reconciliation_required::text from public.team_catalog_updater_items where catalog_material_id='${sheet}'`
        )
      ).toBe('new-claim:false');
    }, 15000);
    it('keeps an old terminal and makes a racing Stop observe the quarantine', async () => {
      const sheet = await fixture(),
        command = randomUUID();
      await sql(asActor(request(command, sheet)));
      await sql(`update public.team_catalog_update_attempts set result='failed',failure_code='DRIVE_UNAVAILABLE',ended_at=clock_timestamp() where catalog_material_id='${sheet}';
        update public.team_catalog_updater_items set lease_owner='park-owner',lease_expires_at=clock_timestamp()+interval '1 minute' where catalog_material_id='${sheet}';`);
      const parked = sql(
        `begin;select public.service_park_catalog_update_claim('${sheet}','park-owner');select pg_sleep(2) /* claim_quarantine_hold */;commit;`
      );
      await held('claim_quarantine_hold');
      const stopping = sql(
        asActor(
          `select public.cancel_team_catalog_update('${team}','${sheet}') /* claim_stop_wait */`
        )
      );
      const rejected = expect(stopping).rejects.toThrow(/CATALOG_UPDATE_RECONCILIATION_REQUIRED/);
      await held('claim_stop_wait', 'Lock');
      await parked;
      await rejected;
      expect(
        await sql(
          `select result||':'||failure_code from public.team_catalog_update_attempts where catalog_material_id='${sheet}'`
        )
      ).toBe('failed:DRIVE_UNAVAILABLE');
      expect(await count(sheet)).toBe('1');
    }, 15000);
    it('serializes replacement bulk groups before either acceptance becomes visible', async () => {
      const sheet = await fixture(),
        firstId = randomUUID(),
        otherId = randomUUID();
      const start = (id: string) =>
        `select public.start_team_bulk_trash_as_actor('${team}','${id}',array['${sheet}']::uuid[],'${owner}')`;
      const first = sql(asActor(`${start(firstId)};select pg_sleep(2) /* trash_accept_hold */`));
      await held('trash_accept_hold');
      const second = sql(asActor(`${start(otherId)} /* trash_overlap_wait */`)).then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      );
      await held('trash_overlap_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select count(*) from private.team_bulk_trash_groups where id in ('${firstId}','${otherId}')`
        )
      ).toBe('1');
    }, 15000);
    it('allows same-key bulk replay after a concurrent acceptance commits', async () => {
      const sheet = await fixture(),
        group = randomUUID();
      const start = `select public.start_team_bulk_trash('${team}','${group}',array['${sheet}']::uuid[])`;
      const first = sql(asActor(`${start};select pg_sleep(2) /* trash_replay_hold */`));
      await held('trash_replay_hold');
      const second = sql(asActor(`${start} /* trash_replay_wait */`));
      await held('trash_replay_wait', 'Lock');
      expect(receipt(await second)).toEqual(receipt(await first));
    }, 15000);
    it('fences a racing child selection by another actor behind the accepted parent', async () => {
      const sheet = await fixture(),
        folder = randomUUID(),
        otherActor = randomUUID(),
        firstId = randomUUID(),
        otherId = randomUUID();
      await sql(`begin;
        insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values('${otherActor}','authenticated','authenticated','${otherActor}@bulk-race.test.invalid','{}','{}');
        insert into public.admin_users(user_id) values('${otherActor}');
        insert into public.team_members(team_id,user_id,base_role) values('${team}','${otherActor}','admin');
        insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,mime_type) values('${folder}','${team}','${connection}','${folder}','root','Synthetic folder','folder','application/vnd.google-apps.folder');
        update public.team_materials set parent_folder_id='${folder}' where id='${sheet}';commit;`);
      const first = sql(
        asActor(
          `select public.start_team_bulk_trash('${team}','${firstId}',array['${folder}']::uuid[]);select pg_sleep(2) /* trash_parent_hold */`
        )
      );
      await held('trash_parent_hold');
      const second = sql(
        `begin;select set_config('request.jwt.claim.sub','${otherActor}',true);set local role authenticated;select public.start_team_bulk_trash_as_actor('${team}','${otherId}',array['${sheet}']::uuid[],'${otherActor}') /* trash_child_wait */;commit;`
      ).then(
        value => ({ value, error: null }),
        error => ({ value: null, error })
      );
      await held('trash_child_wait', 'Lock');
      await first;
      expect((await second).error?.message).toContain('PROCESS_RESULT_UNCERTAIN');
      expect(
        await sql(
          `select count(*) from private.team_bulk_trash_groups where id in ('${firstId}','${otherId}')`
        )
      ).toBe('1');
    }, 15000);
  }
);
