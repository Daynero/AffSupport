import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';

/*
 * 070: two opens of the assistant at the same moment (a fresh browser, two tabs) made two dialogs:
 * both found none and both inserted one. The open is serialised per space and person, so the
 * second waits for the first and returns its dialog. Two real sessions are needed for that, which
 * pgTAP inside one transaction cannot give.
 */
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  staff = randomUUID(),
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

function open(marker: string, hold = 0): Promise<string> {
  return sql(`begin;
    select set_config('request.jwt.claim.sub', '${owner}', true) \\g /dev/null
    select public.assistant_open_dialog('${team}', null) ->> 'conversationId' /* ${marker} */;
    ${hold ? `select pg_sleep(${hold}) /* ${marker}_hold */ \\g /dev/null` : ''}
    commit;`);
}

async function waiting(marker: string, event: 'PgSleep' | 'Lock') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and query like '%${marker}%' and query not like '%pg_stat_activity%'
        and ${event === 'Lock' ? "wait_event_type='Lock'" : "wait_event='PgSleep'"}`)) === '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `assistant open ${marker} ${event}` }
  );
}

describe.skipIf(!container)(
  '070 assistant open is idempotent [needs: disposable process PostgreSQL container]',
  () => {
    beforeAll(async () => {
      await sql(`begin;
        insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
          ('${owner}','authenticated','authenticated','${owner}@assistant-open.test.invalid','{}','{}'),
          ('${staff}','authenticated','authenticated','${staff}@assistant-open.test.invalid','{}','{}');
        insert into public.admin_users(user_id) values('${staff}');
        insert into public.teams(id,name,owner_id) values('${team}','Synthetic assistant open','${owner}');
        insert into public.team_members(team_id,user_id,base_role,permission_overrides) values
          ('${team}','${owner}','admin','{}'),
          -- a staff member keeps the space open under the legacy tariff rule
          ('${team}','${staff}','viewer','{}');
        insert into private.ai_settings(id,assistant_enabled) values(true,true)
          on conflict(id) do update set assistant_enabled = true;
        insert into private.ai_space_pilot(team_id) values('${team}') on conflict do nothing;
        commit;`);
    });

    it('a second open while the first is still running returns the same dialog', async () => {
      // The first open has made its dialog and holds its transaction open; the second must wait
      // for it rather than make another.
      const first = open('assistant_open_first', 3);
      await waiting('assistant_open_first_hold', 'PgSleep');
      const second = open('assistant_open_second');
      await waiting('assistant_open_second', 'Lock');
      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatch(/^[0-9a-f-]{36}$/u);
      expect(b).toBe(a);
      expect(
        await sql(`select count(*) from private.assistant_conversations where team_id='${team}'`)
      ).toBe('1');
    }, 15000);

    it('two opens started together still leave one dialog', async () => {
      await sql(`delete from private.assistant_conversations where team_id='${team}'`);
      const ids = await Promise.all([open('assistant_open_pair_a'), open('assistant_open_pair_b')]);
      expect(ids[1]).toBe(ids[0]);
      expect(
        await sql(`select count(*) from private.assistant_conversations where team_id='${team}'`)
      ).toBe('1');
    }, 15000);
  }
);
