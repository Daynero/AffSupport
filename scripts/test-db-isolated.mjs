/** Real Supabase schema, no application data; all writes stay in a disposable container. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const project = /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/mu.exec(
  readFileSync('supabase/config.toml', 'utf8')
)?.[1];
if (!project) throw new Error('A local Supabase project_id is required.');
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
let created = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (created) {
      try {
        docker(['rm', '--force', '--volumes', target]);
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
  docker([
    'run',
    '--detach',
    '--name',
    target,
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
  created = true;
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
  sql(
    docker([
      'exec',
      source,
      'pg_dump',
      '-U',
      'supabase_admin',
      '--schema-only',
      '--clean',
      '--if-exists',
      'postgres'
    ]),
    false
  );
  // Retain real Auth/storage/extension foundations, then replay the application from zero.
  sql(
    'drop schema if exists private cascade; drop schema public cascade; create schema public authorization postgres; grant usage on schema public to public; grant all on schema public to postgres; delete from cron.job;'
  );
  for (const name of readdirSync('supabase/migrations')
    .filter(name => /^\d{14}.*\.sql$/u.test(name))
    .sort()) {
    try {
      sql(readFileSync(`supabase/migrations/${name}`, 'utf8'));
    } catch (cause) {
      throw new Error(`Migration ${name} failed: ${failureMessage(cause)}`, { cause });
    }
  }
  sql(`alter role supabase_admin password '${password}';`);
  const port = /127\.0\.0\.1:(\d+)/u.exec(docker(['port', target, '5432/tcp']))?.[1];
  if (!port) throw new Error('Disposable database must be bound to loopback.');
  console.log(
    'database: isolated real schema; full migration chain; no source data copied; scheduler disabled'
  );
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'supabase',
      'test',
      'db',
      '--db-url',
      `postgresql://supabase_admin:${password}@127.0.0.1:${port}/postgres?sslmode=disable`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32', timeout: 600_000 }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (cause) {
  console.error(`database: ${failureMessage(cause)}`);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      docker(['rm', '--force', '--volumes', target]);
    } catch {
      console.error(`database: failed to remove disposable container ${target}`);
      process.exitCode = 1;
    }
  }
}
