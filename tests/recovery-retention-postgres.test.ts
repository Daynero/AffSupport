import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';
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

describe.skipIf(!container)(
  '036 bounded recovery retention [needs: disposable process PostgreSQL container]',
  () => {
    beforeAll(async () => {
      await sql(`begin;
      insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
      values('${owner}','authenticated','authenticated','${owner}@retention.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      insert into public.teams(id,name,owner_id) values('${team}','Synthetic retention concurrency','${owner}');
      insert into public.team_members(team_id,user_id,base_role) values('${team}','${owner}','admin');
      with pauses as (
        insert into private.workspace_pauses(team_id,state,captured_at)
        select '${team}','recovery_registered',clock_timestamp()-interval '45 days' from generate_series(1,101)
        returning id,team_id,epoch
      ), snapshots as (
        insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,actor_id,captured_at)
        select id,team_id,'catalog_schedule',gen_random_uuid(),'${owner}',clock_timestamp()-interval '45 days' from pauses
        returning id,pause_id,team_id
      ), cycles as (
        insert into private.workspace_recoveries(pause_id,team_id,epoch,state,registered_at,last_progress_at)
        select id,team_id,epoch,'completed',clock_timestamp()-interval '45 days',clock_timestamp()-interval '45 days' from pauses
        returning id,pause_id,team_id
      ) insert into private.workspace_recovery_items(recovery_id,pause_item_id,team_id,state,stage,updated_at)
        select cycles.id,snapshots.id,cycles.team_id,'completed','terminal',clock_timestamp()-interval '45 days'
        from cycles join snapshots using(pause_id,team_id);
      commit;`);
    });
    it('skips a locked old history, removes at most100 other roots, then resumes after the lock releases', async () => {
      const pause = await sql(
        `select pause_id from private.workspace_recoveries where team_id='${team}' order by pause_id limit 1`
      );
      expect(pause).toMatch(/^[0-9a-f-]{36}$/u);
      await sql(
        `update private.workspace_recoveries set last_progress_at=clock_timestamp()-interval '60 days' where pause_id='${pause}'`
      );
      const first = sql(
        `begin;select id from private.workspace_pauses where id='${pause}' for update;select pg_sleep(4) /* retention_pause_hold */;commit;`
      );
      try {
        await held('retention_pause_hold');
        await sql('select private.sweep_workspace_recovery()');
        expect(
          await sql(`select count(*) from private.workspace_pauses where team_id='${team}'`)
        ).toBe('1');
        expect(await sql(`select count(*) from private.workspace_pauses where id='${pause}'`)).toBe(
          '1'
        );
      } finally {
        await first;
      }
      await sql('select private.sweep_workspace_recovery()');
      expect(
        await sql(`select count(*) from private.workspace_pauses where team_id='${team}'`)
      ).toBe('0');
    }, 15000);
  }
);
