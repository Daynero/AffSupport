import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { waitFor } from './support/wait';

const container = process.env.SOTY_TRANSLATION_UPGRADE_CONTAINER;
const order = process.env.SOTY_TRANSLATION_UPGRADE_ORDER;
const id = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function sql(statement: string) {
  assertDisposablePostgresContainer(container);
  return new Promise<string>((resolve, reject) => {
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
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(String(stderr).slice(-2000))) : resolve(stdout.trim())
    );
    child.stdin!.end(statement);
  });
}
const finalize = `select public.service_accept_library_result('${id(2)}','${id(8)}','${id(1)}','${id(11)}',repeat('a',64),'${id(6)}','v1')`;
async function migrations(gated = false) {
  for (const name of readdirSync('supabase/migrations')
    .filter(n => /^\d{14}.*\.sql$/u.test(n) && n >= '20261207090000_retire_translation.sql')
    .sort()) {
    let statement = readFileSync(`supabase/migrations/${name}`, 'utf8');
    if (gated && name === '20261207090000_retire_translation.sql')
      statement = statement.replace(/commit;\s*$/iu, 'select pg_advisory_lock(460046); commit;');
    await sql(`set application_name='046_migration'; ${statement}`);
  }
}
async function barrier() {
  assertDisposablePostgresContainer(container);
  let output = '';
  let child: ReturnType<typeof execFile>;
  const done = new Promise<void>((resolve, reject) => {
    child = execFile(
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
      { timeout: 120000 },
      (error, _stdout, stderr) => (error ? reject(new Error(stderr)) : resolve())
    );
    child.stdout!.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stdin!.write('select pg_advisory_lock(460046);\n\\echo READY\n');
  });
  await waitFor(() => output.includes('READY'), { describe: 'advisory gate acquired' });
  return async () => {
    child!.stdin!.end('select pg_advisory_unlock(460046);\n\\q\n');
    await done;
  };
}

describe.skipIf(!container)('046 upgrade [needs: owned previous-schema PostgreSQL clone]', () => {
  it('serializes retirement against a real old finalizer and preserves existing files', async () => {
    expect(['finalize_first', 'retire_first']).toContain(order);
    const before = await sql(`select count(*) from public.team_materials where team_id='${id(2)}'`);
    const release = await barrier();
    const waiting = (name: string, event: string) =>
      waitFor(
        async () =>
          (await sql(
            `select count(*) from pg_stat_activity where application_name='${name}' and ${event === 'advisory' ? "wait_event='advisory'" : "wait_event_type='Lock' and wait_event <> 'advisory'"}`
          )) === '1',
        { describe: `${name} waiting on ${event}` }
      );
    if (order === 'finalize_first') {
      const held = sql(
        `set application_name='046_finalizer';begin;select id from private.team_library_attempts where id='${id(8)}' for update;update private.team_library_attempts set progress=0 where id='${id(8)}';select pg_advisory_lock(460046);${finalize};commit;`
      );
      const upgrading = (async () => {
        await waiting('046_finalizer', 'advisory');
        return migrations();
      })();
      try {
        await waiting('046_migration', 'relation');
      } finally {
        await release();
      }
      await held;
      await upgrading;
      expect(
        await sql(`select state from public.team_library_requirements where id='${id(7)}'`)
      ).toBe('ready');
    } else {
      const upgrading = migrations(true);
      await waiting('046_migration', 'advisory');
      const finishing = sql(`set application_name='046_finalizer';${finalize}`);
      const rejected = finishing.then(
        () => null,
        (error: unknown) => error
      );
      try {
        await waiting('046_finalizer', 'relation');
      } finally {
        await release();
      }
      await upgrading;
      expect(String(await rejected)).toMatch(/FEATURE_RETIRED|LEASE_EXPIRED/u);
      await expect(sql(finalize)).rejects.toThrow('FEATURE_RETIRED');
      expect(
        await sql(`select state from public.team_library_requirements where id='${id(7)}'`)
      ).toBe('canceled');
    }
    expect(await sql(`select count(*) from public.team_materials where team_id='${id(2)}'`)).toBe(
      before
    );
    expect(
      await sql(`select state||':'||error_code from public.team_operations where id='${id(9)}'`)
    ).toBe('canceled:FEATURE_RETIRED');
    await expect(
      sql(
        `select public.service_prepare_process_upload('${id(9)}','${id(1)}','${id(4)}','synthetic-new',repeat('a',32))`
      )
    ).rejects.toThrow('FEATURE_RETIRED');
    await expect(
      sql(
        `select * from private.consume_team_transfer_grant(extensions.digest(repeat('b',64),'sha256'),'finalize')`
      )
    ).rejects.toThrow('FEATURE_RETIRED');
    await expect(
      sql(
        `insert into public.team_library_requirements(team_id,source_material_id,source_version,kind,variant) values('${id(2)}','${id(5)}','v2','translation','uk')`
      )
    ).rejects.toThrow('FEATURE_RETIRED');
    await expect(
      sql(
        `select * from private.consume_team_transfer_grant(extensions.digest(repeat('c',64),'sha256'),'process_input')`
      )
    ).rejects.toThrow('FEATURE_RETIRED');
    const authenticated = `select set_config('request.jwt.claim.sub','${id(1)}',false);`;
    for (const command of [
      `select public.heartbeat_library_job('${id(2)}','${id(8)}','${id(11)}',repeat('a',64),50,'processing')`,
      `select public.cancel_library_job('${id(2)}','${id(8)}','${id(11)}',repeat('a',64))`,
      `select public.fail_library_job('${id(2)}','${id(8)}','${id(11)}',repeat('a',64),'PROCESS_FAILED')`
    ])
      await expect(sql(authenticated + command)).rejects.toThrow('FEATURE_RETIRED');
    expect(
      (
        await sql(
          authenticated +
            `select public.retry_failed_library_jobs('${id(2)}',array['${id(5)}']::uuid[])`
        )
      )
        .split('\n')
        .at(-1)
    ).toBe('1');
    expect(
      (
        await sql(
          authenticated +
            `select public.retry_failed_library_jobs('${id(2)}',array['${id(5)}']::uuid[])`
        )
      )
        .split('\n')
        .at(-1)
    ).toBe('0');
    expect(
      await sql(
        `select count(*) from public.team_operations o join private.team_operation_intents i on i.operation_id=o.id where i.tool_id='translation' and o.state in ('pending','running')`
      )
    ).toBe('0');
    expect(
      await sql(
        `select count(*) from public.team_library_requirements where kind='translation' and state in ('pending','running','leased','failed')`
      )
    ).toBe('0');

    const readVariants = async () =>
      JSON.parse(
        (await sql(authenticated + `select public.list_video_text_variants('${id(2)}','${id(5)}')`))
          .split('\n')
          .at(-1)!
      );
    // A historical accepted translation must never become an original.
    expect((await readVariants()).variants).toEqual([]);
    await sql(`update public.team_materials set companion_of='${id(5)}', companion_kind='transcript',
      transcript_ingest_state='full', transcript_text='Synthetic original', transcript_truncated=false, transcript_source_version='v1'
      where id='${id(6)}';`);
    expect((await readVariants()).variants).toMatchObject([
      { kind: 'original', materialId: id(6), attemptId: null, text: 'Synthetic original' }
    ]);
    // Current read fixture: only active kinds, no disabled retirement guard.
    await sql(`insert into private.team_library_attempts(id,requirement_id,team_id,actor_id,agent_instance_id,state,lease_token_hash,lease_expires_at,finished_at)
      select '${id(17)}',id,team_id,'${id(1)}','${id(11)}','ready',extensions.digest(repeat('e',64),'sha256'),now()+interval '1 hour',now()
      from public.team_library_requirements where team_id='${id(2)}' and kind='transcription' and variant='original';
      insert into public.team_library_results(team_id,requirement_id,source_material_id,source_version,kind,variant,material_id,accepted_attempt_id,accepted_by)
      select team_id,id,source_material_id,source_version,kind,variant,'${id(6)}','${id(17)}','${id(1)}'
      from public.team_library_requirements where team_id='${id(2)}' and kind='transcription' and variant='original';`);
    const originals = (await readVariants()).variants;
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      kind: 'original',
      attemptId: id(17),
      text: 'Synthetic original'
    });
    await expect(
      sql(`select set_config('request.jwt.claim.sub','${id(18)}',false);
      select public.list_video_text_variants('${id(2)}','${id(5)}')`)
    ).rejects.toThrow('PERMISSION_DENIED');
  }, 120000);
});
