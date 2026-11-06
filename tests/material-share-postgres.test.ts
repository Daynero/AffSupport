import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  const id = randomUUID();
  await sql(`insert into public.team_materials(id,team_id,connection_id,drive_file_id,parent_folder_id,name,kind,category,mime_type)
    values('${id}','${team}','${connection}','${id}','root','Synthetic sheet','file','other','text/csv');`);
  return id;
}
const key = () => `share.v2:${Date.now()}:${randomUUID()}`;
const begin = (id: string, nonce: string) =>
  `select public.service_begin_material_share('${team}','${owner}','${id}','${connection}','${id}','${nonce}',false,false,null)`;
const receipt = (value: string) =>
  JSON.parse(value.split('\n').find(line => line.startsWith('{'))!);
describe.skipIf(!container)('047 material sharing [needs: disposable PostgreSQL container]', () => {
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
  it('issues one permit under a concurrent same-key replay and hashes the provider identity with real SHA-256', async () => {
    const id = await fixture(),
      nonce = key();
    const first = sql(
      `begin;${begin(id, nonce)};select pg_sleep(2) /* share_first_hold */;commit;`
    );
    await held('share_first_hold');
    const replay = sql(`${begin(id, nonce)} /* share_replay_wait */`);
    await held('share_replay_wait', 'Lock');
    const a = receipt(await first),
      b = receipt(await replay);
    expect(a.writeAllowed).toBe(true);
    expect(b).toMatchObject({ intentId: a.intentId, writeAllowed: false, attribution: 'unknown' });
    expect(
      await sql(
        `select file_fingerprint from private.team_material_share_intents where id='${a.intentId}'`
      )
    ).toBe(createHash('sha256').update(`${team}:${id}`).digest('hex'));
  }, 15000);
  it('blocks a competing key while the original per-file write remains unknown', async () => {
    const id = await fixture();
    const first = sql(
      `begin;${begin(id, key())};select pg_sleep(2) /* share_competing_hold */;commit;`
    );
    await held('share_competing_hold');
    const competing = sql(`${begin(id, key())} /* share_competing_wait */`);
    await held('share_competing_wait', 'Lock');
    expect(receipt(await first).writeAllowed).toBe(true);
    expect(receipt(await competing)).toMatchObject({ state: 'blocked', writeAllowed: false });
    expect(
      await sql(
        `select count(*) from private.team_material_share_intents where team_id='${team}' and provider_file_id='${id}' and state='write_started'`
      )
    ).toBe('1');
  }, 15000);
  it('refuses a stale observation after another request completes without granting a second permit', async () => {
    const id = await fixture(),
      first = receipt(await sql(begin(id, key())));
    await sql(
      `select public.service_confirm_material_share('${team}','${owner}','${first.intentId}','${id}',null,false)`
    );
    await expect(sql(begin(id, key()))).rejects.toThrow(/STALE_RESULT/);
    expect(
      await sql(
        `select count(*) from private.team_material_share_intents where team_id='${team}' and file_fingerprint=encode(extensions.digest(convert_to('${team}:${id}','UTF8'),'sha256'),'hex')`
      )
    ).toBe('1');
  });
});
