/** Real Supabase schema, no application data; all writes stay in a disposable container. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resetApplicationSchemas } from './lib/supabase-schema-baseline.mjs';
import { cleanupDisposableAuth, cleanupDisposableDatabase } from './lib/disposable-auth.mjs';

const configuredProject = /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/mu.exec(
  readFileSync('supabase/config.toml', 'utf8')
)?.[1];
// The optional override chooses a local schema baseline only, never an application-data target.
const project = process.env.SOTY_TEST_DB_SOURCE_PROJECT ?? configuredProject;
if (!project || !/^[a-zA-Z0-9_-]+$/u.test(project)) {
  throw new Error('A valid local Supabase source project_id is required; remote URLs are refused.');
}
const source = `supabase_db_${project}`;
const target = `soty-test-db-${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
const sql = (statement, transaction = true) =>
  docker(
    [
      'exec',
      '-i',
      target,
      'psql',
      '-X',
      '-q',
      ...(transaction ? ['--single-transaction'] : []),
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      '-d',
      'postgres'
    ],
    statement
  );
function failureMessage(cause) {
  if (cause instanceof Error)
    return String('stderr' in cause ? cause.stderr : cause.message).slice(-3000);
  return String(cause);
}
let creationAttempted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (creationAttempted) {
      try {
        cleanupDisposableAuth(target, docker);
      } catch {
        process.stderr.write('database: disposable Auth cleanup requires inspection\n');
      }
      try {
        cleanupDisposableDatabase(target, docker);
      } catch {
        /* Gate reports interruption. */
      }
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
try {
  const image = docker(['inspect', '--format', '{{.Config.Image}}', source]).trim();
  if (!/^(?:public\.ecr\.aws|ghcr\.io)\/supabase\/postgres:[a-zA-Z0-9._-]+$/u.test(image))
    throw new Error('Expected a local Supabase PostgreSQL image.');
  // Ownership is inspectable even if Docker creates the container but loses its reply.
  creationAttempted = true;
  docker([
    'run',
    '--detach',
    '--cpus',
    '1',
    '--memory',
    '512m',
    '--name',
    target,
    '--label',
    `soty.acceptance.database=${target}`,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_DB=postgres',
    image,
    'postgres',
    '-D',
    '/var/lib/postgresql/data',
    '-c',
    'config_file=/etc/postgresql/postgresql.conf',
    '-c',
    'cron.launch_active_jobs=off'
  ]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      docker(['exec', target, 'pg_isready', '-h', '127.0.0.1', '-U', 'supabase_admin']);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Disposable PostgreSQL did not start.');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const roles = docker([
    'exec',
    source,
    'pg_dumpall',
    '-U',
    'supabase_admin',
    '--roles-only',
    '--no-role-passwords'
  ]);
  // Copy role identity/attributes and membership only: never passwords or custom role settings.
  const roleStatements = roles
    .split('\n')
    .filter(line => /^(?:CREATE ROLE |ALTER ROLE \w+ WITH |GRANT |REVOKE )/u.test(line))
    .join('\n')
    .replace(
      /^CREATE ROLE ([a-z_][a-z_0-9]*);$/gmu,
      (_, name) =>
        `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN CREATE ROLE ${name}; END IF; END $$;`
    );
  sql(roleStatements);
  const schemaDump = docker([
    'exec',
    source,
    'pg_dump',
    '-U',
    'supabase_admin',
    '--schema-only',
    '--clean',
    '--if-exists',
    'postgres'
  ]);
  sql(schemaDump, false);
  // Two independent prefix fixtures, with the feature migrations applied inside the race test.
  for (const order of ['finalize_first', 'retire_first']) {
    sql(resetApplicationSchemas(schemaDump));
    const migrationNames = readdirSync('supabase/migrations')
      .filter(name => /^\d{14}.*\.sql$/u.test(name))
      .sort();
    const boundary = migrationNames.indexOf('20261207090000_retire_translation.sql');
    if (boundary < 0) throw new Error('Retirement migration boundary is missing.');
    for (const name of migrationNames.slice(0, boundary))
      sql(readFileSync(`supabase/migrations/${name}`, 'utf8'));
    sql(readFileSync('tests/fixtures/translation-retirement-upgrade.sql', 'utf8'));
    const child = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/translation-retirement-upgrade-postgres.test.ts',
        '--maxWorkers=1',
        '--no-file-parallelism'
      ],
      {
        env: {
          ...process.env,
          SOTY_TRANSLATION_UPGRADE_CONTAINER: target,
          SOTY_TRANSLATION_UPGRADE_ORDER: order,
          NODE_OPTIONS: '--max-old-space-size=1024'
        },
        stdio: 'inherit',
        shell: false,
        timeout: 300000
      }
    );
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Retirement upgrade failed: ${order}`);
  }
  if (process.env.SOTY_TRANSLATION_GENERATE_TYPES === '1') {
    const database = `soty_tariff_test_${randomBytes(16).toString('hex')}`;
    sql(`alter role supabase_admin password '${password}';`, false);
    // Only this owned disposable database: temporarily stop its extension-worker
    // connections so PostgreSQL can clone the synthetic schema fixture for the
    // canonical type generator's isolated database-name guard.
    docker(
      [
        'exec',
        '-i',
        target,
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'supabase_admin',
        '-d',
        'template1'
      ],
      `alter database postgres allow_connections false;
       select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres';
       create database ${database} template postgres;
       alter database postgres allow_connections true;`
    );
    const port = /127\.0\.0\.1:(\d+)/u.exec(docker(['port', target, '5432/tcp']))?.[1];
    if (!port) throw new Error('Disposable database must be bound to loopback.');
    const generated = spawnSync('npm', ['run', 'types:supabase:local'], {
      env: {
        ...process.env,
        SOTY_ISOLATED_DB_TYPES_URL: `postgresql://supabase_admin:${password}@127.0.0.1:${port}/${database}?sslmode=disable`
      },
      stdio: 'inherit',
      shell: false,
      timeout: 180000
    });
    if (generated.error || generated.status !== 0)
      throw new Error('Local schema type generation failed.');
  }
} catch (cause) {
  console.error(`database: ${failureMessage(cause)}`);
  process.exitCode = 1;
} finally {
  if (creationAttempted) {
    try {
      cleanupDisposableAuth(target, docker);
    } catch {
      console.error('database: disposable Auth cleanup failed; inspect owned resources');
      process.exitCode = 1;
    }
    try {
      cleanupDisposableDatabase(target, docker);
    } catch {
      console.error(`database: failed to remove disposable container ${target}`);
      process.exitCode = 1;
    }
  }
}
