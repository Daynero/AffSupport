/** Synthetic query-plan experiment only; never connects to an application database. */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const project = process.env.SOTY_TEST_DB_SOURCE_PROJECT;
if (!project || !/^[a-zA-Z0-9_-]+$/u.test(project))
  throw new Error('Set SOTY_TEST_DB_SOURCE_PROJECT to an existing local Supabase project.');
const target = `soty-test-db-${randomBytes(8).toString('hex')}`;
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  });
// Read the image identity only. No schema, rows, role definitions or credentials
// are read from the source container.
const image = docker(['inspect', '--format', '{{.Config.Image}}', `supabase_db_${project}`]).trim();
if (!/^(?:public\.ecr\.aws|ghcr\.io)\/supabase\/postgres:[a-zA-Z0-9._-]+$/u.test(image))
  throw new Error('Expected a local Supabase PostgreSQL image.');
const migration = readFileSync(
  'supabase/migrations/20261202110000_operational_history_retention.sql',
  'utf8'
);
const cleaner = migration.match(
  /create or replace function private\.cleanup_cron_history\([\s\S]*?\n\$\$;/u
)?.[0];
if (!cleaner) throw new Error('Cleaner definition not found.');
const sql = input =>
  docker(
    [
      'exec',
      '-i',
      target,
      'psql',
      '-XqAt',
      '-h',
      '127.0.0.1',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      '-d',
      'postgres'
    ],
    input
  ).trim();
let created = false;
try {
  created = true;
  docker([
    'run',
    '--detach',
    '--name',
    target,
    '--label',
    `soty.acceptance.database=${target}`,
    '--cpus=1',
    '--memory=512m',
    '--memory-swap=512m',
    '--network=none',
    '--env',
    `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
    image,
    'postgres',
    '-D',
    '/var/lib/postgresql/data',
    '-c',
    'config_file=/etc/postgresql/postgresql.conf',
    '-c',
    'cron.launch_active_jobs=off',
    '-c',
    'shared_buffers=128MB'
  ]);
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      sql('select 1');
      break;
    } catch {
      if (performance.now() > deadline) throw new Error('Disposable PostgreSQL did not start.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  sql(`create schema if not exists private; create schema if not exists cron;
    create table cron.job_run_details(runid bigint primary key,status text,end_time timestamptz);
    ${cleaner}`);
  const cases = [];
  for (const rows of [10_000, 500_000]) {
    for (const expired of [false, true]) {
      sql(`truncate cron.job_run_details;
        insert into cron.job_run_details
        select n,'succeeded',clock_timestamp()-interval '${expired ? '8 days' : '1 day'}'
        from generate_series(1,${rows}) n;
        analyze cron.job_run_details;`);
      // The exact victim-selection query from the cleaner, with the same bound.
      const plan = JSON.parse(
        sql(`explain (analyze,buffers,format json)
        select d.runid from cron.job_run_details d
        where d.end_time < current_timestamp-interval '7 days'
        and d.status in ('succeeded','failed') order by d.runid limit 500;`)
      );
      const started = performance.now();
      const removed = Number(sql('select private.cleanup_cron_history()'));
      cases.push({ rows, expired, removed, elapsed_ms: performance.now() - started, plan });
      if (removed !== (expired ? 500 : 0)) throw new Error('Unexpected cleaner deletion count.');
    }
  }
  console.log(
    JSON.stringify(
      {
        scope: 'synthetic_retention_only',
        image,
        limits: { cpus: 1, memory_mib: 512, swap: false, network: false },
        limitations: [
          'minimal synthetic cron table',
          'no authenticated user workload',
          'local storage and CPU differ from production',
          'elapsed includes docker/psql overhead'
        ],
        cases
      },
      null,
      2
    )
  );
} finally {
  if (created) docker(['rm', '--force', '--volumes', target]);
}
