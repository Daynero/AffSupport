import { assertDisposablePostgresContainer } from './support/disposable-postgres';
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

async function sql(statement: string, transaction = true): Promise<string> {
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      ...(transaction ? ['--single-transaction'] : []),
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
    assertDisposablePostgresContainer(container);
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
    // One Docker/psql process avoids hundreds of process launches on a loaded VM.
    // Keep each migration's transaction boundary, including enum changes that
    // must commit before a later migration can use the new value.
    const migrations = readdirSync('supabase/migrations')
      .filter(name => name.endsWith('.sql'))
      .sort()
      .map(name => {
        const source = readFileSync(`supabase/migrations/${name}`, 'utf8')
          .replace(/create extension if not exists citext with schema extensions;/gu, '')
          .replaceAll('extensions.citext', 'text')
          .replace(/create extension if not exists pg_cron with schema pg_catalog;/gu, '')
          .replace(/create extension if not exists pg_net with schema extensions;/gu, '');
        return `BEGIN;\n${source}\n;\nCOMMIT;`;
      });
    await sql(migrations.join('\n'), false);
    if (process.env.SOTY_GENERATE_RECOVERY_DB_TYPES === '1') {
      // The disposable acceptance DB has its own port. The running beta's status
      // URL addresses a different database and must never be used for this read.
      const isolated = process.env.SOTY_TEST_POSTGRES_URL;
      if (!isolated) throw new Error('ISOLATED_TYPES_DATABASE_URL_REQUIRED');
      const url = new URL(isolated);
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
        `select public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('owner@tariff-concurrency.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(0)::integer))->>'id';`
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

  it('serializes two native installations of one member while another catalog is queued', async () => {
    const secondSheet = randomUUID(),
      secondVideo = randomUUID();
    const firstDelegation = randomUUID(),
      secondDelegation = randomUUID();
    const marker = `catalog_claim_${randomUUID().replaceAll('-', '')}`;
    await sql(`insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
      select '${secondSheet}',team_id,connection_id,'${secondSheet}','root','Synthetic second sheet','file','other','application/vnd.google-apps.spreadsheet'
      from public.team_materials where id='${sheet}';
      insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
      select '${secondVideo}',team_id,connection_id,'${secondVideo}','root','Synthetic second video','file','video','video/mp4'
      from public.team_materials where id='${sheet}';
      select public.service_link_product_catalog_companion('${team}','${secondVideo}','${secondSheet}',null,
        jsonb_build_object('sourceLink','https://offer.example.test','productCount',3,
          'sheetUrl','https://docs.google.com/spreadsheets/d/second/edit','videoLink','https://drive.google.com/file/d/second/view',
          'createdBy','${owner}','settingsSnapshot',jsonb_build_object('title','Synthetic','description','Synthetic','price',10,'imageLink','https://example.test/image.png')));
      select set_config('request.jwt.claim.sub','${owner}',true);
      select public.save_team_catalog_updater('${team}',array['${sheet}','${secondSheet}']::uuid[],'1h',true);
      select public.patch_team_catalog_update_profile('${team}',catalog_material_id,version,'{"restitch":true}'::jsonb)
        from public.team_catalog_update_profiles where catalog_material_id in ('${sheet}','${secondSheet}');
      insert into private.team_recovery_delegations(id,team_id,actor_id,installation_id,refresh_hash) values
        ('${firstDelegation}','${team}','${owner}',gen_random_uuid(),decode(repeat('91',32),'hex')),
        ('${secondDelegation}','${team}','${owner}',gen_random_uuid(),decode(repeat('92',32),'hex'));`);
    const claim = (
      delegation: string,
      hash: string
    ) => `select set_config('soty.background_recovery','${delegation}',true);
      select public.service_claim_restitch_job('${team}','${owner}',decode(repeat('${hash}',32),'hex'),120)->>'jobId';`;
    const first = sql(`${claim(firstDelegation, '93')} select pg_sleep(3) /*${marker}*/;`);
    try {
      await waitForTransaction(marker);
      // The first lease is still invisible to this second connection. The member
      // advisory lock must prevent it from taking the other, unlocked catalog.
      expect((await sql(claim(secondDelegation, '94'))).split('\n').slice(1).join('')).toBe('');
      const chosen = (await first).split('\n')[1];
      expect([sheet, secondSheet]).toContain(chosen);
      expect((await sql(claim(secondDelegation, '95'))).split('\n').slice(1).join('')).toBe('');
      expect(
        await sql(
          `select count(*) from private.catalog_restitch_jobs where team_id='${team}' and state='leased'`
        )
      ).toBe('1');
      expect(
        await sql(
          `select count(*) from private.catalog_restitch_jobs where team_id='${team}' and state='queued'`
        )
      ).toBe('1');
    } finally {
      await first;
      await sql(`delete from private.team_recovery_delegations where id in ('${firstDelegation}','${secondDelegation}');
        select set_config('request.jwt.claim.sub','${owner}',true);
        select public.stop_team_catalog_updater('${team}');
        select public.patch_team_catalog_update_profile('${team}',catalog_material_id,version,'{"restitch":false}'::jsonb)
          from public.team_catalog_update_profiles where catalog_material_id='${sheet}';
        delete from public.team_materials where id='${secondSheet}';
        delete from public.team_materials where id='${secondVideo}';
        select public.set_team_catalog_update_interval('${team}',array['${sheet}']::uuid[],'1d');`);
    }
  }, 20_000);

  it('a pause sweep skips a locked renewal and cannot pause its committed active tariff', async () => {
    await sql(
      `update public.space_tariffs set ends_on=private.kyiv_today()-10 where id='${tariff}';`
    );
    const renewal =
      asAdmin(`begin;select 1 from public.space_tariffs where id='${tariff}' for update;
      select pg_sleep(4) /* tariff_renew_lock */;
      select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));commit;`);
    await waitForTransaction('tariff_renew_lock');
    expect(await sql(`select private.apply_tariff_pauses('${team}')`)).toBe('0');
    await renewal;
    expect(await state()).toBe('1d');
    expect(await sql(`select private.apply_tariff_pauses('${team}')`)).toBe('0');
  }, 20_000);

  it('a manual stop committed while renewal waits wins over the old pause snapshot', async () => {
    await asAdmin(
      `select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'end',jsonb_build_object('now',(true)::boolean));`
    );
    // Synthetic admin fixture models the interval writer under the updater lock;
    // it cannot call the user RPC while access is closed.
    const stop =
      sql(`begin;select 1 from public.team_catalog_updaters where team_id='${team}' for update;
      update public.team_catalog_updater_items set paused_interval=null,update_interval=null,next_run_at=null
      where catalog_material_id='${sheet}';select pg_sleep(4) /* tariff_stop_lock */;commit;`);
    await waitForTransaction('tariff_stop_lock');
    const renewal = asAdmin(
      `select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));`
    );
    await stop;
    await renewal;
    expect(await state()).toBe('');
  }, 20_000);
  it('refuses a stale worker lease after closure and keeps one recovery on repeated renewal', async () => {
    await sql(
      `select set_config('request.jwt.claim.sub','${owner}',false); select public.set_team_catalog_update_interval('${team}',array['${sheet}']::uuid[],'1d');`
    );
    await asAdmin(
      `select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'end',jsonb_build_object('now',(true)::boolean));`
    );
    await expect(
      sql(
        `update public.team_catalog_updater_items set lease_owner='stale-worker',lease_expires_at=clock_timestamp()+interval '2 minutes' where catalog_material_id='${sheet}';`
      )
    ).rejects.toThrow(/SPACE_BLOCKED/u);
    await asAdmin(
      `select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));`
    );
    const recoveries = await sql(
      `select count(*) from private.workspace_recoveries where team_id='${team}'`
    );
    await asAdmin(
      `select public.admin_mutate_space_tariff('${tariff}',gen_random_uuid(),(select updated_at from public.space_tariffs where id='${tariff}'),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));`
    );
    expect(
      await sql(`select count(*) from private.workspace_recoveries where team_id='${team}'`)
    ).toBe(recoveries);
  });

  it('renews ten five-member spaces without duplicate catch-up jobs or exceeding twelve worker leases', async () => {
    const result = await sql(`do $proof$
    declare actor uuid; member_id uuid; workspace uuid; plan uuid; cred uuid; conn uuid; video uuid; catalog uuid;
      teams uuid[]:='{}'; catalog_count integer; lease_count integer; started timestamptz:=clock_timestamp();
    begin
      -- Team has two base seats; explicitly grant three more for each five-member fixture.
      for n in 1..10 loop
        actor:=gen_random_uuid();
        insert into auth.users(id,email,email_confirmed_at,last_sign_in_at)
          values(actor,'load-'||actor||'@recovery.test',now(),now());
        insert into public.profiles(id,display_name,account_status) values(actor,'Synthetic load','active') on conflict(id) do nothing;
        perform set_config('request.jwt.claim.sub','${admin}',true);
        plan:=(public.admin_grant_space_tariff_once(gen_random_uuid(),jsonb_build_object('email',('load-'||actor||'@recovery.test')::text,'plan',('lead')::text,'endsOn',(private.kyiv_today()+30)::date,'extraSeats',(3)::integer))->>'id')::uuid;
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
        perform public.admin_mutate_space_tariff(plan,gen_random_uuid(),(select updated_at from public.space_tariffs where id=plan),'end',jsonb_build_object('now',(true)::boolean));
        perform public.admin_mutate_space_tariff(plan,gen_random_uuid(),(select updated_at from public.space_tariffs where id=plan),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));
        perform public.admin_mutate_space_tariff(plan,gen_random_uuid(),(select updated_at from public.space_tariffs where id=plan),'extend',jsonb_build_object('months',(1)::integer,'notify',(false)::boolean));
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
      challenge:=public.service_team_recovery('delegate',decode(repeat('11',32),'hex'),jsonb_build_object('protocolVersion',2,'actorId','${owner}','teamId','${team}','installationId','34000000-0000-4000-8000-000000000003'));
      perform public.service_team_recovery('redeem',decode(repeat('11',32),'hex'),jsonb_build_object('protocolVersion',2,'challengeId',challenge->>'challengeId','refresh',repeat('a',43),'refreshHash','\\x'||repeat('22',32)));
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
  it('commits exactly one execution reservation across concurrent native checkpoint calls', async () => {
    const operation = randomUUID();
    const installation = randomUUID();
    const request = randomUUID();
    await sql(`do $setup$ declare challenge jsonb; begin
      challenge:=public.service_team_recovery('delegate',decode(repeat('71',32),'hex'),jsonb_build_object('protocolVersion',2,'actorId','${owner}','teamId','${team}','installationId','${installation}'));
      perform public.service_team_recovery('redeem',decode(repeat('71',32),'hex'),jsonb_build_object('protocolVersion',2,'challengeId',challenge->>'challengeId','refresh',repeat('q',43),'refreshHash','\\x'||repeat('72',32)));
      perform public.service_team_recovery('rotate',decode(repeat('72',32),'hex'),jsonb_build_object('rotationId','${randomUUID()}','refresh',repeat('r',43),'refreshHash','\\x'||repeat('73',32),'claim',repeat('s',43),'claimHash','\\x'||repeat('74',32)));
      perform public.service_team_recovery('claim',decode(repeat('74',32),'hex'),jsonb_build_object('protocolVersion',2,'requestId','${request}'));
      insert into public.team_operations(id,team_id,actor_id,kind,state,idempotency_key,request_nonce) values('${operation}','${team}','${owner}','process','pending','${operation}','${operation}');
      perform public.service_team_recovery('register_claim',decode(repeat('74',32),'hex'),jsonb_build_object('protocolVersion',2,'requestId','${request}','response',jsonb_build_object('job',jsonb_build_object('operationId','${operation}','jobId','${request}'),'operationCredential',repeat('x',43)),'operationHash','\\x'||repeat('77',32)));
    end $setup$;`);
    const input = `jsonb_build_object('protocolVersion',2,'operationId','${operation}','jobId','${request}')`;
    const marker = `execution_fence_${randomUUID().replaceAll('-', '')}`;
    const first = sql(
      `select public.service_begin_team_recovery_execution(decode(repeat('77',32),'hex'),${input})->>'executionAllowed';select pg_sleep(2) /*${marker}*/;`
    );
    await waitForTransaction(marker);
    const second = sql(
      `select public.service_begin_team_recovery_execution(decode(repeat('77',32),'hex'),${input})->>'executionAllowed';`
    );
    expect(await first).toBe('true');
    expect(await second).toBe('false');
    expect(
      await sql(
        `select count(*) from private.team_recovery_execution_fences where operation_id='${operation}'`
      )
    ).toBe('1');
    await expect(
      sql(
        `select public.service_team_recovery('checkpoint',decode(repeat('77',32),'hex'),${input})`
      )
    ).rejects.toThrow(/PROCESS_RESULT_UNCERTAIN/);
  });
});
