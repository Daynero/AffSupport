import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './support/wait.js';
const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const owner = randomUUID(),
  installation = randomUUID();
let team: string;
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
function holdSql(statement: string): { commit: () => Promise<string> } {
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
  void result.catch(() => undefined);
  child.stdin!.write(`begin;${statement};\n`);
  return {
    commit: () => {
      child.stdin!.end('commit;\n');
      return result;
    }
  };
}
async function held(marker: string, event = 'PgSleep') {
  await waitFor(
    async () =>
      (await sql(`select count(*) from pg_stat_activity where datname=current_database()
    and pid<>pg_backend_pid() and query like '%${marker}%' and ${event === 'Lock' ? "wait_event_type='Lock'" : event === 'Idle' ? "state='idle in transaction'" : "wait_event='PgSleep'"}`)) ===
      '1',
    { timeoutMs: 5000, intervalMs: 30, describe: `isolated transaction ${marker} ${event}` }
  );
}

describe.skipIf(!container)(
  '036 installation retirement races [needs: disposable PostgreSQL]',
  () => {
    beforeAll(async () => {
      team =
        await sql(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
      values('${owner}','authenticated','authenticated','${owner}@retirement.test.invalid','{}','{}');
      insert into public.admin_users(user_id) values('${owner}');
      do $$ begin
        perform set_config('request.jwt.claim.sub','${owner}',true);
        perform public.admin_grant_space_tariff('${owner}@retirement.test.invalid','lead',private.kyiv_today()+30,0);
        perform public.create_team('Synthetic retirement concurrency');
      end $$;
      select id from public.teams where owner_id='${owner}' and name='Synthetic retirement concurrency';`);
      expect(team).toMatch(/^[0-9a-f-]{36}$/u);
    });
    async function challenge() {
      const receipt =
        await sql(`select public.service_team_recovery('delegate',decode(repeat('11',32),'hex'),
      jsonb_build_object('actorId','${owner}','teamId','${team}','installationId','${installation}','protocolVersion',2))->>'challengeId'`);
      expect(receipt).toMatch(/^[0-9a-f-]{36}$/u);
      return receipt;
    }
    function redeemStatement(ticket: string, marker: string) {
      return `select public.service_team_recovery('redeem',decode(repeat('11',32),'hex'),
        jsonb_build_object('challengeId','${ticket}','refresh',repeat('r',43),
        'refreshHash',chr(92)||'x'||repeat('22',32),'protocolVersion',2)) /* ${marker} */`;
    }
    function logoutStatement(marker: string, scope = installation) {
      return `select set_config('request.jwt.claim.sub','${owner}',true);
        select public.retire_team_recovery_installation('${scope}') /* ${marker} */`;
    }
    function logout(marker: string, scope = installation) {
      return sql(`begin;${logoutStatement(marker, scope)};commit;`);
    }
    it('retires a redeem that already holds the installation lock before logout', async () => {
      const ticket = await challenge();
      const first = holdSql(redeemStatement(ticket, 'retirement_redeem_first'));
      let second: Promise<string> | undefined;
      try {
        await held('retirement_redeem_first', 'Idle');
        second = logout('retirement_logout_wait');
        // Attach a handler before observing the lock, so a failure is never unhandled.
        void second.catch(() => undefined);
        await held('retirement_logout_wait', 'Lock');
      } finally {
        await first.commit();
        await second;
      }
      expect(
        await sql(`select count(*) from private.team_recovery_delegations
      where actor_id='${owner}' and installation_id='${installation}' and revoked_at is null`)
      ).toBe('0');
    }, 15000);
    it('rejects a redeem whose ticket was retired while it waited for logout', async () => {
      // Previous delegation uses the same test hash; the new ticket must never create another one.
      const ticket = await challenge();
      const first = holdSql(logoutStatement('retirement_logout_first'));
      let second: Promise<{ ok: boolean; message?: string }> | undefined;
      try {
        await held('retirement_logout_first', 'Idle');
        second = sql(`begin;${redeemStatement(ticket, 'retirement_redeem_wait')};commit;`).then(
          () => ({ ok: true }),
          error => ({ ok: false, message: String(error.message) })
        );
        await held('retirement_redeem_wait', 'Lock');
      } finally {
        await first.commit();
      }
      expect(await second).toMatchObject({
        ok: false,
        message: expect.stringContaining('AUTH_REQUIRED')
      });
      expect(
        await sql(`select count(*) from private.team_recovery_delegations
      where actor_id='${owner}' and installation_id='${installation}' and revoked_at is null`)
      ).toBe('0');
    }, 15000);
    it('does not serialize a different installation behind the held logout', async () => {
      const first = holdSql(logoutStatement('retirement_scope_hold'));
      try {
        await held('retirement_scope_hold', 'Idle');
        await logout('retirement_other_installation', randomUUID());
        await held('retirement_scope_hold', 'Idle');
      } finally {
        await first.commit();
      }
    }, 15000);
  }
);
