import { waitFor } from './support/wait.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in to a local Supabase container. All writes are confined to a
// disposable database; no existing beta database, roles or credentials change.
const container = process.env.SOTY_TARIFF_POSTGRES_CONTAINER;
const run = promisify(execFile);
const database = `soty_tariff_test_${randomUUID().replaceAll('-', '')}`;
const admin = '34000000-0000-4000-8000-000000000001';
const owner = '34000000-0000-4000-8000-000000000002';
let created = false;
let team: string;
let tariff: string;
let sheet: string;

async function sql(statement: string): Promise<string> {
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      '--single-transaction',
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      database
    ],
    { maxBuffer: 1024 * 1024, timeout: 90_000 }
  );
  const result = new Promise<string>((resolve, reject) => {
    let output = '';
    let error = '';
    child.stdout!.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr!.on('data', chunk => {
      error = (error + String(chunk)).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output.trim()) : reject(new Error(error))));
  });
  child.stdin!.end(statement);
  return result;
}
const asAdmin = (statement: string) =>
  sql(`select set_config('request.jwt.claim.sub','${admin}',false);${statement}`);
const state = () =>
  sql(
    `select update_interval from public.team_catalog_updater_items where catalog_material_id='${sheet}'`
  );

// Synchronize using a real held lock, rather than timing the two writers by
// chance. pg_stat_activity contains synthetic SQL in this isolated database only.
async function waitForTransaction(marker: string): Promise<void> {
  await waitFor(
    async () => {
      const ready =
        await sql(`select count(*) from pg_stat_activity where datname=current_database()
      and query like '%${marker}%' and wait_event='PgSleep' and pid<>pg_backend_pid()`);
      return ready === '1';
    },
    { timeoutMs: 10_000, intervalMs: 50, describe: 'synthetic transaction held lock' }
  );
}

describe.skipIf(!container)('034 recovery [needs: SOTY_TARIFF_POSTGRES_CONTAINER]', () => {
  beforeAll(async () => {
    if (!/^supabase_db_[a-zA-Z0-9_-]+$/.test(container!))
      throw new Error('Local Supabase container required.');
    await run('docker', ['exec', container!, 'createdb', '-U', 'postgres', database]);
    created = true;
    const support = readFileSync('tests/support/team-db.ts', 'utf8');
    const match = /const SUPABASE_STUBS = `([\s\S]*?)`;/u.exec(support);
    if (!match) throw new Error('Missing test schema.');
    // Roles are cluster-wide and already provided by Supabase. Never mutate them.
    await sql(
      match[1]!
        .replace(/^\s*create role[^;]+;/gmu, '')
        .replace(
          / {2}create schema vault;[\s\S]*?(?= {2}create schema storage;)/u,
          '  create extension supabase_vault;\n'
        )
    );
    for (const name of readdirSync('supabase/migrations')
      .filter(name => name.endsWith('.sql'))
      .sort()) {
      await sql(
        readFileSync(`supabase/migrations/${name}`, 'utf8')
          .replace(/create extension if not exists citext with schema extensions;/gu, '')
          .replaceAll('extensions.citext', 'text')
          .replace(/create extension if not exists pg_cron with schema pg_catalog;/gu, '')
          .replace(/create extension if not exists pg_net with schema extensions;/gu, '')
      );
    }
    if (process.env.SOTY_GENERATE_RECOVERY_DB_TYPES === '1') {
      const status = await run('npx', ['supabase', 'status', '--output', 'json'], {
        maxBuffer: 1024 * 1024
      });
      const local = JSON.parse(status.stdout) as { DB_URL: string };
      const url = new URL(local.DB_URL);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Local database required.');
      url.pathname = `/${database}`;
      await run('node', ['scripts/generate-local-db-types.mjs'], {
        env: { ...process.env, SOTY_ISOLATED_DB_TYPES_URL: url.toString() },
        maxBuffer: 1024 * 1024,
        timeout: 90000
      });
    }
    await sql(`insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values
      ('${admin}','admin@tariff-concurrency.test',now(),now()),('${owner}','owner@tariff-concurrency.test',now(),now());
      insert into public.profiles(id,display_name,account_status) values
      ('${admin}','Synthetic admin','active'),('${owner}','Synthetic owner','active') on conflict(id) do nothing;
      insert into public.admin_users(user_id) values('${admin}');`);
    tariff = (
      await asAdmin(
        `select public.admin_grant_space_tariff('owner@tariff-concurrency.test','lead',private.kyiv_today()+30,0)->>'id';`
      )
    )
      .split('\n')
      .at(-1)!;
    team = (
      await sql(
        `select set_config('request.jwt.claim.sub','${owner}',false);select id from public.create_team('Synthetic concurrency');`
      )
    )
      .split('\n')
      .at(-1)!;
    sheet = await sql(`with credential as (
      insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
      values('synthetic','owner@tariff-concurrency.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),'${owner}') returning id
    ), connection as (
      insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
      select '${team}',id,'root','Synthetic','my_drive','connected',now() from credential returning id
    ) insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
      select '${team}',id,'synthetic-sheet','root','Synthetic sheet','file','other','application/vnd.google-apps.spreadsheet' from connection returning id;`);
    await sql(`with video as (
      insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
      select team_id,connection_id,'synthetic-video','root','Synthetic video','file','video','video/mp4'
      from public.team_materials where id='${sheet}' returning id
    ) select public.service_link_product_catalog_companion('${team}',id,'${sheet}',null,
      jsonb_build_object('sourceLink','https://offer.example.test','productCount',3,
      'sheetUrl','https://docs.google.com/spreadsheets/d/synthetic/edit',
      'videoLink','https://drive.google.com/file/d/synthetic/view','createdBy','${owner}',
      'settingsSnapshot',jsonb_build_object('title','Synthetic','description','Synthetic','price',10,'imageLink','https://example.test/image.png')))
      from video;
      select set_config('request.jwt.claim.sub','${owner}',false);
      select public.set_team_catalog_update_interval('${team}',array['${sheet}']::uuid[],'1d');`);
  }, 120_000);
  afterAll(async () => {
    if (created)
      await run('docker', ['exec', container!, 'dropdb', '--force', '-U', 'postgres', database], {
        timeout: 25000
      });
  }, 30000);

  it('a pause sweep skips a locked renewal and cannot pause its committed active tariff', async () => {
    await sql(
      `update public.space_tariffs set ends_on=private.kyiv_today()-10 where id='${tariff}';`
    );
    const renewal =
      asAdmin(`begin;select 1 from public.space_tariffs where id='${tariff}' for update;
      select pg_sleep(4) /* tariff_renew_lock */;
      select public.admin_extend_space_tariff('${tariff}',1,false);commit;`);
    await waitForTransaction('tariff_renew_lock');
    expect(await sql(`select private.apply_tariff_pauses('${team}')`)).toBe('0');
    await renewal;
    expect(await state()).toBe('1d');
    expect(await sql(`select private.apply_tariff_pauses('${team}')`)).toBe('0');
  }, 20_000);

  it('a manual stop committed while renewal waits wins over the old pause snapshot', async () => {
    await asAdmin(`select public.admin_end_space_tariff('${tariff}',true);`);
    // Synthetic admin fixture models the interval writer under the updater lock;
    // it cannot call the user RPC while access is closed.
    const stop =
      sql(`begin;select 1 from public.team_catalog_updaters where team_id='${team}' for update;
      update public.team_catalog_updater_items set paused_interval=null,update_interval=null,next_run_at=null
      where catalog_material_id='${sheet}';select pg_sleep(4) /* tariff_stop_lock */;commit;`);
    await waitForTransaction('tariff_stop_lock');
    const renewal = asAdmin(`select public.admin_extend_space_tariff('${tariff}',1,false);`);
    await stop;
    await renewal;
    expect(await state()).toBe('');
  }, 20_000);
  it('refuses a stale worker lease after closure and keeps one recovery on repeated renewal', async () => {
    await sql(
      `select set_config('request.jwt.claim.sub','${owner}',false); select public.set_team_catalog_update_interval('${team}',array['${sheet}']::uuid[],'1d');`
    );
    await asAdmin(`select public.admin_end_space_tariff('${tariff}',true);`);
    await expect(
      sql(
        `update public.team_catalog_updater_items set lease_owner='stale-worker',lease_expires_at=clock_timestamp()+interval '2 minutes' where catalog_material_id='${sheet}';`
      )
    ).rejects.toThrow(/SPACE_BLOCKED/u);
    await asAdmin(`select public.admin_extend_space_tariff('${tariff}',1,false);`);
    const recoveries = await sql(
      `select count(*) from private.workspace_recoveries where team_id='${team}'`
    );
    await asAdmin(`select public.admin_extend_space_tariff('${tariff}',1,false);`);
    expect(
      await sql(`select count(*) from private.workspace_recoveries where team_id='${team}'`)
    ).toBe(recoveries);
  });

  it('renews ten five-member spaces without duplicate catch-up jobs or exceeding twelve worker leases', async () => {
    const result = await sql(`do $proof$
    declare actor uuid; member_id uuid; workspace uuid; plan uuid; cred uuid; conn uuid; video uuid; catalog uuid;
      teams uuid[]:='{}'; catalog_count integer; lease_count integer; started timestamptz:=clock_timestamp();
    begin
      for n in 1..10 loop
        actor:=gen_random_uuid();
        insert into auth.users(id,email,email_confirmed_at,last_sign_in_at)
          values(actor,'load-'||actor||'@recovery.test',now(),now());
        insert into public.profiles(id,display_name,account_status) values(actor,'Synthetic load','active') on conflict(id) do nothing;
        perform set_config('request.jwt.claim.sub','${admin}',true);
        plan:=(public.admin_grant_space_tariff('load-'||actor||'@recovery.test','lead',private.kyiv_today()+30,0)->>'id')::uuid;
        perform set_config('request.jwt.claim.sub',actor::text,true);
        select id into workspace from public.create_team('Synthetic bounded renewal');
        teams:=array_append(teams,workspace);
        for m in 1..4 loop
          member_id:=gen_random_uuid();
          insert into auth.users(id,email,email_confirmed_at,last_sign_in_at) values(member_id,'member-'||member_id||'@recovery.test',now(),now());
          insert into public.profiles(id,display_name,account_status) values(member_id,'Synthetic member','active') on conflict(id) do nothing;
          insert into public.team_members(team_id,user_id,base_role) values(workspace,member_id,'viewer');
        end loop;
        insert into private.google_drive_credentials(google_permission_id,google_account_email,scope,vault_secret_id,connected_by)
          values('synthetic-'||actor,'load@recovery.test','https://www.googleapis.com/auth/drive.file',gen_random_uuid(),actor) returning id into cred;
        insert into public.team_drive_connections(team_id,credential_id,root_folder_id,root_folder_name,drive_kind,state,connected_at)
          values(workspace,cred,'root','Synthetic','my_drive','connected',now()) returning id into conn;
        for c in 1..3 loop
          insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
            values(workspace,conn,'video-'||c,'root','Synthetic video','file','video','video/mp4') returning id into video;
          insert into public.team_materials(team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
            values(workspace,conn,'sheet-'||c,'root','Synthetic catalog','file','other','application/vnd.google-apps.spreadsheet') returning id into catalog;
          perform public.service_link_product_catalog_companion(workspace,video,catalog,null,
            jsonb_build_object('sourceLink','https://offer.example.test','productCount',3,'sheetUrl','https://docs.google.com/spreadsheets/d/synthetic/edit',
              'videoLink','https://drive.google.com/file/d/synthetic/view','createdBy',actor,
              'settingsSnapshot',jsonb_build_object('title','Synthetic','description','Synthetic','price',10,'imageLink','https://example.test/image.png')));
          perform public.set_team_catalog_update_interval(workspace,array[catalog],'1d');
        end loop;
        perform set_config('request.jwt.claim.sub','${admin}',true);
        perform public.admin_end_space_tariff(plan,true);
        perform public.admin_extend_space_tariff(plan,1,false);
        perform public.admin_extend_space_tariff(plan,1,false);
      end loop;
      select count(*) into catalog_count from public.team_catalog_updater_items where team_id=any(teams) and update_interval='1d';
      if catalog_count<>30 then raise exception 'restored % catalogs instead of 30',catalog_count; end if;
      if (select count(*) from private.workspace_recoveries where team_id=any(teams))<>10 then raise exception 'duplicate recovery cycles'; end if;
      perform public.service_open_catalog_updater_rounds();
      perform public.service_claim_catalog_updater_items('synthetic-mass-renewal',50,60);
      select count(*) into lease_count from public.team_catalog_updater_items where lease_expires_at>clock_timestamp();
      if lease_count>12 then raise exception 'worker budget exceeded: %',lease_count; end if;
      if clock_timestamp()-started>interval '60 seconds' then raise exception 'queue registration exceeded 60 seconds'; end if;
    end $proof$;select 'bounded-renewal-ok';`);
    expect(result).toBe('bounded-renewal-ok');
  }, 90_000);

  it('rotates and cleans encrypted replay secrets using the real Supabase Vault extension', async () => {
    const result = await sql(`do $proof$
    declare challenge jsonb; first_reply jsonb; replay jsonb;
    begin
      challenge:=public.service_team_recovery('delegate',decode(repeat('11',32),'hex'),jsonb_build_object('actorId','${owner}','teamId','${team}','installationId','34000000-0000-4000-8000-000000000003'));
      perform public.service_team_recovery('redeem',decode(repeat('11',32),'hex'),jsonb_build_object('challengeId',challenge->>'challengeId','refresh',repeat('a',43),'refreshHash','\\x'||repeat('22',32)));
      first_reply:=public.service_team_recovery('rotate',decode(repeat('22',32),'hex'),jsonb_build_object('rotationId','34000000-0000-4000-8000-000000000004','refresh',repeat('b',43),'refreshHash','\\x'||repeat('33',32),'claim',repeat('c',43),'claimHash','\\x'||repeat('44',32)));
      replay:=public.service_team_recovery('rotate',decode(repeat('22',32),'hex'),jsonb_build_object('rotationId','34000000-0000-4000-8000-000000000004'));
      if replay is distinct from first_reply then raise exception 'rotation replay changed'; end if;
      if exists(select 1 from vault.secrets where name like 'soty-recovery-%' and position(repeat('b',43) in secret)>0) then raise exception 'plaintext replay secret'; end if;
      update private.team_recovery_delegations set last_rotation_at=clock_timestamp()-interval '5 minutes' where team_id='${team}';
      perform public.service_team_recovery('rotate',decode(repeat('33',32),'hex'),jsonb_build_object('rotationId','34000000-0000-4000-8000-000000000005','refresh',repeat('d',43),'refreshHash','\\x'||repeat('55',32),'claim',repeat('e',43),'claimHash','\\x'||repeat('66',32)));
      update private.team_recovery_delegations set rotation_replay_until=clock_timestamp()-interval '1 second' where team_id='${team}';
      perform private.sweep_workspace_recovery();
      if exists(select 1 from private.team_recovery_delegations where team_id='${team}' and rotation_secret_id is not null) then raise exception 'expired replay retained'; end if;
    end $proof$; select 'vault-proof-ok';`);
    expect(result).toBe('vault-proof-ok');
  });
});
