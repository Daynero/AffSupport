/** Vendor/mini interoperability proof. Every writable database is owned and disposable. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { resetApplicationSchemas } from './supabase-schema-baseline.mjs';
import {
  analyseMiniDbSql,
  assertMiniDbTupleSource,
  assertMiniDbSafety,
  assertMiniDbTransition
} from './mini-db-policy.mjs';
import {
  applyMiniDbPlan,
  dbValueDigest,
  readMiniDbSnapshot,
  validateMiniDbSnapshot
} from './mini-db-transaction.mjs';

const SOURCE_LIMIT = 64 * 1024 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024;
const CLI_VERSION = '2.117.0';
const PATH = /^supabase\/migrations\/(\d{14})_([a-zA-Z0-9_]+)\.sql$/u;
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

/** @returns {never} */
function fail(code) {
  throw new Error(code);
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function same(a, b) {
  return (
    a.historyDigest === b.historyDigest &&
    a.catalogDigest === b.catalogDigest &&
    a.ledgerDigest === b.ledgerDigest &&
    a.pgMajor === b.pgMajor &&
    dbValueDigest(a.extensions) === dbValueDigest(b.extensions)
  );
}

/** No credential-bearing inherited environment reaches the vendor CLI or Git. */
function environment(home) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    CI: 'true',
    GOMAXPROCS: '1',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  };
}

/** @param {string} executable @param {string[]} args
 * @param {{cwd?:string,input?:string,env?:Record<string,string>,limit?:number,timeout?:number}} [options]
 * @returns {Promise<string>} */
function command(
  executable,
  args,
  { cwd, input, env = environment(tmpdir()), limit = SOURCE_LIMIT, timeout = 120_000 } = {}
) {
  return new Promise((accept, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd, env, encoding: 'utf8', maxBuffer: limit, timeout, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          const tool = basename(executable);
          const operation = args.includes('psql')
            ? 'psql'
            : args.includes('pg_dumpall')
              ? 'roles-dump'
              : args.includes('pg_dump')
                ? 'schema-dump'
                : args.includes('pg_isready')
                  ? 'ready'
                  : args.includes('db') && args.includes('push')
                    ? 'db-push'
                    : args[0]?.startsWith('--')
                      ? 'version'
                      : args
                          .slice(0, 2)
                          .filter(value => /^[a-z-]+$/u.test(value))
                          .join('-');
          const status =
            typeof error.code === 'number'
              ? String(error.code)
              : typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
                ? error.code
                : 'unknown';
          const safe = String(stderr)
            .slice(-8192)
            .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[local-database-url]')
            .replace(/[a-f0-9]{48}/giu, '[ephemeral-secret]')
            .replace(/(password\s*(?:=|:)?\s*)[^\s,;]+/giu, '$1[redacted]');
          try {
            const directory = join(
              process.cwd(),
              'release/automation/web-only-implementation/db-command-diagnostics'
            );
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            writeFileSync(
              join(directory, `${randomBytes(8).toString('hex')}.json`),
              JSON.stringify({ tool, operation, status, signal: error.signal, stderr: safe }),
              { mode: 0o600, flag: 'wx' }
            );
          } catch {
            /* The public failure remains bounded and secret-free. */
          }
          reject(new Error(`DB_REHEARSAL_LOCAL_COMMAND_FAILED:${tool}:${operation}:${status}`));
        } else accept(stdout);
      }
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Read all SQL from the immutable clean source commit, never from candidate paths on disk.
 * @param {{cwd:string,plan:any,readGit?:((args:string[])=>Promise<string>)|null}} options */
export async function loadMiniDbMigrationSources({ cwd, plan, readGit = null }) {
  const git = readGit ?? (args => command('git', args, { cwd, limit: SOURCE_LIMIT }));
  if (
    !COMMIT.test(plan?.sourceSha ?? '') ||
    !Array.isArray(plan.inventory) ||
    plan.inventory.length > 4096
  )
    fail('DB_REHEARSAL_SOURCE_INVALID');
  if (
    (await git(['rev-parse', 'HEAD'])).trim() !== plan.sourceSha ||
    (await git(['status', '--porcelain=v1', '--untracked-files=normal'])).trim()
  )
    fail('DB_REHEARSAL_CLEAN_SOURCE_REQUIRED');
  const flags = await git(['ls-files', '-v', '--', 'supabase/migrations']);
  if (flags.split('\n').some(line => line && (!line.startsWith('H ') || line.startsWith('S '))))
    fail('DB_REHEARSAL_HIDDEN_SOURCE_FLAGS');
  const tree = (await git(['ls-tree', '-r', plan.sourceSha, '--', 'supabase/migrations']))
    .trim()
    .split('\n')
    .filter(Boolean);
  const tracked = new Set(
    tree
      .filter(line => !/^100644 blob [a-f0-9]{40}\tsupabase\/migrations\/ROLLBACK\.md$/u.test(line))
      .map(line => {
        const match = /^100644 blob [a-f0-9]{40}\t(.+)$/u.exec(line);
        if (!match || !PATH.test(match[1])) fail('DB_REHEARSAL_MIGRATION_TREE_UNSUPPORTED');
        return match[1];
      })
  );
  if (tracked.size !== plan.inventory.length) fail('DB_REHEARSAL_INVENTORY_INCOMPLETE');
  let previous = '';
  let total = 0;
  const result = [];
  for (const item of plan.inventory) {
    const match = PATH.exec(item?.path ?? '');
    if (
      !match ||
      item.version !== match[1] ||
      item.name !== match[2] ||
      !SHA.test(item.sourceDigest ?? '') ||
      item.version <= previous ||
      !tracked.delete(item.path)
    )
      fail('DB_REHEARSAL_INVENTORY_INVALID');
    const sql = await git(['show', `${plan.sourceSha}:${item.path}`]);
    const bytes = Buffer.byteLength(sql);
    total += bytes;
    if (
      bytes > FILE_LIMIT ||
      total > SOURCE_LIMIT ||
      sql.includes('\0') ||
      hash(sql) !== item.sourceDigest
    )
      fail('DB_REHEARSAL_SOURCE_MISMATCH');
    previous = item.version;
    result.push({ ...item, sql });
  }
  return result;
}

/** Validate the source prefix, target identity and supported pending SQL before creating resources. */
export function validateMiniDbRehearsalDraft(plan, binding, targetBeforeSnapshot, sources) {
  if (
    plan?.kind !== 'mini-db-draft' ||
    plan.schemaVersion !== 1 ||
    !COMMIT.test(plan.agentSha ?? '') ||
    !SHA.test(binding?.digest ?? '') ||
    plan.bindingDigest !== binding.digest ||
    !Array.isArray(plan.migrations)
  )
    fail('DB_REHEARSAL_DRAFT_INVALID');
  const before = validateMiniDbSnapshot(targetBeforeSnapshot);
  const declared = validateMiniDbSnapshot(plan.before);
  if (
    !same(before, declared) ||
    !same(before, targetBeforeSnapshot) ||
    !same(declared, plan.before)
  )
    fail('DB_REHEARSAL_TARGET_CHANGED');
  if (before.history.length > sources.length) fail('DB_REHEARSAL_HISTORY_NOT_PREFIX');
  before.history.forEach((row, index) => {
    if (row.version !== sources[index].version || row.name !== sources[index].name)
      fail('DB_REHEARSAL_HISTORY_NOT_PREFIX');
  });
  const pending = sources.slice(before.history.length);
  if (pending.length !== plan.migrations.length) fail('DB_REHEARSAL_PENDING_MISMATCH');
  pending.forEach((item, index) => {
    const supplied = plan.migrations[index];
    if (
      !supplied ||
      ['version', 'name', 'path', 'sourceDigest', 'sql'].some(key => supplied[key] !== item[key])
    )
      fail('DB_REHEARSAL_PENDING_MISMATCH');
    if (!analyseMiniDbSql(item.sql).ok) fail('DB_REHEARSAL_SQL_NOT_ADDITIVE');
  });
  return { before, baseline: sources.slice(0, before.history.length), pending };
}

async function snapshot(connectionString) {
  // This function is called only with URLs constructed from the owned container below.
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 30_000,
    statement_timeout: 30_000
  });
  try {
    await client.connect();
    return await readMiniDbSnapshot(client);
  } finally {
    await client.end().catch(() => client.connection?.stream?.destroy());
  }
}

/** Docker internal networks intentionally have no host NAT on recent engines.
 * Tunnel only local sockets to the exact owned container; never enable egress. */
async function ownedDatabaseProxy(containerId, env, cwd) {
  const sockets = new Set();
  const children = new Set();
  let stopping = false;
  const server = createServer(socket => {
    if (stopping || sockets.size >= 16 || children.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(120_000, () => socket.destroy());
    const child = spawn('docker', ['exec', '-i', containerId, 'nc', '127.0.0.1', '5432'], {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    children.add(child);
    child.stdin.on('error', () => socket.destroy());
    child.stdout.on('error', () => socket.destroy());
    child.on('error', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    child.once('close', () => {
      children.delete(child);
      socket.destroy();
    });
    socket.once('close', () => {
      sockets.delete(socket);
      child.stdin.end();
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });
  server.maxConnections = 16;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      accept(null);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
    fail('DB_REHEARSAL_PROXY_LOOPBACK_REQUIRED');
  server.on('error', () => stop());
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    for (const child of children) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill('SIGTERM');
    }
  }
  return { port: address.port, stop };
}

/** Owned resources only. The local source container is inspected/dumped, never modified. */
export async function createMiniDbRehearsalRuntime({
  cwd,
  cliPath = process.env.SOTY_MINI_SUPABASE_CLI ||
    (existsSync(join(cwd, 'release/automation/mini-db-tools/node_modules/.bin/supabase'))
      ? join(cwd, 'release/automation/mini-db-tools/node_modules/.bin/supabase')
      : join(homedir(), '.local/bin/supabase'))
}) {
  if (process.platform === 'win32') fail('DB_REHEARSAL_PLATFORM_UNSUPPORTED');
  const configured = /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/mu.exec(
    await readFile(join(cwd, 'supabase/config.toml'), 'utf8')
  )?.[1];
  const project = process.env.SOTY_TEST_DB_SOURCE_PROJECT ?? configured;
  if (!project || !/^[a-zA-Z0-9_-]+$/u.test(project)) fail('DB_REHEARSAL_LOCAL_SOURCE_REQUIRED');
  const source = `supabase_db_${project}`;
  const nonce = randomBytes(8).toString('hex');
  const names = Object.fromEntries(
    ['baseline', 'vendor', 'mini'].map(key => [key, `soty_mini_db_${nonce}_${key}`])
  );
  const container = `soty-test-db-${nonce}`;
  const network = `soty-mini-db-net-${nonce}`;
  const password = randomBytes(24).toString('hex');
  const workdir = await mkdtemp(join(tmpdir(), 'soty-mini-db-'));
  await chmod(workdir, 0o700);
  const env = environment(workdir);
  // Docker Desktop stores its local Unix-socket context under the real HOME.
  // Do not inherit DOCKER_HOST/CONTEXT: a remote daemon is outside this runner.
  const dockerEnv = { ...env, HOME: homedir() };
  const docker = (args, input) => command('docker', args, { cwd, env: dockerEnv, input });
  let attempted = false;
  let networkAttempted = false;
  let closed = false;
  let proxy = null;
  async function cleanupOwned() {
    proxy?.stop();
    if (
      attempted &&
      (await docker(['container', 'ls', '-aq', '--filter', `name=^/${container}$`])).trim()
    ) {
      const info = JSON.parse(await docker(['container', 'inspect', container]))[0];
      if (
        info?.Config?.Labels?.['soty.acceptance.database'] !== container ||
        !/^[a-f0-9]{64}$/u.test(info.Id ?? '')
      )
        fail('DB_REHEARSAL_CLEANUP_OWNER_MISMATCH');
      await docker(['rm', '--force', '--volumes', info.Id]);
      if ((await docker(['container', 'ls', '-aq', '--filter', `id=${info.Id}`])).trim())
        fail('DB_REHEARSAL_CLEANUP_UNCONFIRMED');
    }
    if (
      networkAttempted &&
      (await docker(['network', 'ls', '-q', '--filter', `name=^${network}$`])).trim()
    ) {
      const info = JSON.parse(await docker(['network', 'inspect', network]))[0];
      if (
        info?.Labels?.['soty.acceptance.database'] !== container ||
        Object.keys(info.Containers ?? {}).length
      )
        fail('DB_REHEARSAL_NETWORK_CLEANUP_UNCONFIRMED');
      await docker(['network', 'rm', network]);
    }
  }
  const interrupt = () => {
    proxy?.stop();
    let confirmed = !attempted;
    try {
      // The supervisor gives this owner two seconds. Request deletion first,
      // using the exact inspected container ID, and never wait ten seconds here.
      if (attempted) {
        const quick = (args, timeout = 300) =>
          execFileSync('docker', args, {
            encoding: 'utf8',
            timeout,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
            env: dockerEnv
          });
        let info;
        try {
          info = JSON.parse(quick(['container', 'inspect', container]))[0];
        } catch {
          if (!quick(['container', 'ls', '-aq', '--filter', `name=^/${container}$`]).trim())
            confirmed = true;
        }
        if (info) {
          if (
            info.Config?.Labels?.['soty.acceptance.database'] !== container ||
            !/^[a-f0-9]{64}$/u.test(info.Id)
          )
            fail('DB_REHEARSAL_CLEANUP_OWNER_MISMATCH');
          quick(['rm', '--force', '--volumes', info.Id], 500);
          confirmed = !quick(['container', 'ls', '-aq', '--filter', `id=${info.Id}`]).trim();
        }
      }
    } catch {
      confirmed = false;
    }
    if (!confirmed) process.stderr.write('WEB_MANAGED_CLEANUP_UNCONFIRMED\n');
    // Networks and SQL staging own no processes. Best effort after the CPU owner stops.
    if (confirmed && networkAttempted) {
      try {
        execFileSync('docker', ['network', 'rm', network], {
          timeout: 200,
          killSignal: 'SIGKILL',
          stdio: 'ignore',
          env: dockerEnv
        });
      } catch {
        /* No running database remains; normal cleanup can reconcile the owned network. */
      }
    }
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* Private staging only. */
    }
    process.exit(143);
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await cleanupOwned();
    } catch (error) {
      process.stderr.write('WEB_MANAGED_CLEANUP_UNCONFIRMED\n');
      throw error;
    } finally {
      process.removeListener('SIGTERM', interrupt);
      process.removeListener('SIGINT', interrupt);
      await rm(workdir, { recursive: true, force: true });
    }
  }
  try {
    const endpoint = (
      await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    ).trim();
    if (!/^unix:\/\/\//u.test(endpoint)) fail('DB_REHEARSAL_LOCAL_DOCKER_REQUIRED');
    if (
      (await command(cliPath, ['--version'], { cwd: workdir, env, limit: 4096 })).trim() !==
      CLI_VERSION
    )
      fail('DB_REHEARSAL_OFFICIAL_CLI_VERSION_REQUIRED');
    const image = (await docker(['inspect', '--format', '{{.Config.Image}}', source])).trim();
    const imageId = (await docker(['inspect', '--format', '{{.Image}}', source])).trim();
    if (
      !/^(?:public\.ecr\.aws|ghcr\.io)\/supabase\/postgres:[a-zA-Z0-9._-]+$/u.test(image) ||
      !/^sha256:[a-f0-9]{64}$/u.test(imageId)
    )
      fail('DB_REHEARSAL_LOCAL_IMAGE_UNSUPPORTED');
    networkAttempted = true;
    await docker([
      'network',
      'create',
      '--internal',
      '--label',
      `soty.acceptance.database=${container}`,
      network
    ]);
    attempted = true;
    await docker([
      'run',
      '--detach',
      '--name',
      container,
      '--label',
      `soty.acceptance.database=${container}`,
      '--cpus=1',
      '--memory=512m',
      '--memory-swap=512m',
      '--pids-limit=128',
      '--network',
      network,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=postgres',
      imageId,
      'postgres',
      '-D',
      '/var/lib/postgresql/data',
      '-c',
      'config_file=/etc/postgresql/postgresql.conf',
      '-c',
      'cron.launch_active_jobs=off',
      '-c',
      `cron.database_name=${names.baseline}`,
      '-c',
      'shared_buffers=64MB',
      '-c',
      'work_mem=4MB',
      '-c',
      'maintenance_work_mem=32MB',
      '-c',
      'max_parallel_workers=0',
      '-c',
      'max_connections=20'
    ]);
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        break;
      } catch {
        if (Date.now() >= deadline) fail('DB_REHEARSAL_START_TIMEOUT');
      }
      await new Promise(accept => setTimeout(accept, 250));
    }
    const psql = (database, sql, transaction = true) =>
      docker(
        [
          'exec',
          '-i',
          container,
          'psql',
          '-X',
          '-q',
          ...(transaction ? ['--single-transaction'] : []),
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'supabase_admin',
          '-d',
          database
        ],
        sql
      );
    const roles = await docker([
      'exec',
      source,
      'pg_dumpall',
      '-U',
      'supabase_admin',
      '--roles-only',
      '--no-role-passwords'
    ]);
    const definitions = roles
      .split('\n')
      .filter(line => /^(?:CREATE ROLE |ALTER ROLE \w+ WITH |GRANT |REVOKE )/u.test(line))
      .join('\n')
      .replace(
        /^CREATE ROLE ([a-z_][a-z_0-9]*);$/gmu,
        (_, name) =>
          `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN CREATE ROLE ${name}; END IF; END $$;`
      );
    await psql('postgres', definitions);
    const schema = await docker([
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
    await psql(
      'postgres',
      `CREATE DATABASE ${names.baseline} WITH TEMPLATE template0 OWNER postgres`,
      false
    );
    await psql(names.baseline, schema, false);
    await psql(names.baseline, resetApplicationSchemas(schema));
    await psql('postgres', `ALTER ROLE postgres PASSWORD '${password}'`);
    const ownedContainer = JSON.parse(await docker(['container', 'inspect', container]))[0];
    if (
      ownedContainer?.Config?.Labels?.['soty.acceptance.database'] !== container ||
      !/^[a-f0-9]{64}$/u.test(ownedContainer.Id ?? '')
    )
      fail('DB_REHEARSAL_PROXY_OWNER_MISMATCH');
    proxy = await ownedDatabaseProxy(ownedContainer.Id, dockerEnv, cwd);
    const port = proxy.port;
    const urls = Object.fromEntries(
      Object.entries(names).map(([key, name]) => [
        key,
        `postgresql://postgres:${password}@127.0.0.1:${port}/${name}?sslmode=disable`
      ])
    );
    const stage = join(workdir, 'supabase');
    await mkdir(join(stage, 'migrations'), { recursive: true, mode: 0o700 });
    await writeFile(join(stage, 'config.toml'), 'project_id = "soty-mini-db-rehearsal"\n', {
      mode: 0o600
    });
    const written = new Set();
    async function push(database, files) {
      if (!urls[database]) fail('DB_REHEARSAL_OWNED_DATABASE_REQUIRED');
      for (const item of files) {
        const name = basename(item.path);
        if (!PATH.test(item.path) || hash(item.sql) !== item.sourceDigest)
          fail('DB_REHEARSAL_SOURCE_MISMATCH');
        if (written.has(name)) continue;
        await writeFile(join(stage, 'migrations', name), item.sql, { mode: 0o600, flag: 'wx' });
        written.add(name);
      }
      await command(
        cliPath,
        ['--workdir', workdir, 'db', 'push', '--db-url', urls[database], '--include-all', '--yes'],
        { cwd: workdir, env, limit: 1024 * 1024, timeout: 180_000 }
      );
    }
    return {
      imageId,
      cliVersion: CLI_VERSION,
      urls,
      push,
      snapshot: database => snapshot(urls[database]),
      clone: async () => {
        // pg_cron's launcher also connects when scheduled jobs are disabled.
        // Seal only this owned template before terminating its own sessions;
        // no later stage reads baseline after its immutable snapshot is taken.
        await psql('postgres', `ALTER DATABASE ${names.baseline} ALLOW_CONNECTIONS false`, false);
        await psql(
          'postgres',
          `SELECT pg_catalog.pg_terminate_backend(pid,2000)
          FROM pg_catalog.pg_stat_activity WHERE datname='${names.baseline}' AND pid<>pg_catalog.pg_backend_pid()`,
          false
        );
        for (const name of [names.vendor, names.mini])
          await psql(
            'postgres',
            `CREATE DATABASE ${name} WITH TEMPLATE ${names.baseline} OWNER postgres`,
            false
          );
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function persistArtifact(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let part = resolve(directory); ; part = dirname(part)) {
    const stat = await lstat(part);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('DB_REHEARSAL_ARTIFACT_DIRECTORY_UNSAFE');
    if (dirname(part) === part) break;
  }
  const stat = await lstat(directory);
  if (process.getuid && stat.uid !== process.getuid()) fail('DB_REHEARSAL_ARTIFACT_OWNER_MISMATCH');
  await chmod(directory, 0o700);
  const path = join(directory, `rehearsal-${randomBytes(12).toString('hex')}.json`);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return path;
}

/** deps are trusted code injection for unit tests, never candidate JSON or shell commands.
 * @param {{cwd:string,plan:any,binding:any,targetBeforeSnapshot?:any,artifactDirectory?:string,deps?:any}} options */
export async function rehearseMiniDbPlan({
  cwd,
  plan,
  binding,
  targetBeforeSnapshot = plan.before,
  artifactDirectory = join(cwd, 'release/automation/mini-db-rehearsals'),
  deps = {}
}) {
  // Freeze caller-controlled approval material before the first asynchronous read.
  plan = JSON.parse(JSON.stringify(plan));
  binding = JSON.parse(JSON.stringify(binding));
  targetBeforeSnapshot = JSON.parse(JSON.stringify(targetBeforeSnapshot));
  const sources = await (deps.loadSources ?? loadMiniDbMigrationSources)({ cwd, plan });
  const { before, baseline, pending } = validateMiniDbRehearsalDraft(
    plan,
    binding,
    targetBeforeSnapshot,
    sources
  );
  (deps.assertSafety ?? assertMiniDbSafety)(before, pending);
  const runtime = await (deps.createRuntime ?? createMiniDbRehearsalRuntime)({ cwd });
  let result;
  try {
    await runtime.push('baseline', baseline);
    const replayed = await runtime.snapshot('baseline');
    if (!same(replayed, before)) fail('DB_REHEARSAL_BASELINE_MISMATCH');
    let after = before;
    let migrations = [];
    let interoperability = 'not_needed';
    if (pending.length) {
      await runtime.clone();
      await runtime.push('vendor', sources);
      after = await runtime.snapshot('vendor');
      if (
        after.pgMajor !== before.pgMajor ||
        dbValueDigest(after.extensions) !== dbValueDigest(before.extensions) ||
        after.history.length !== sources.length ||
        dbValueDigest(after.history.slice(0, baseline.length)) !== before.historyDigest
      )
        fail('DB_REHEARSAL_VENDOR_HISTORY_MISMATCH');
      migrations = pending.map((item, index) => {
        const tuple = after.history[baseline.length + index];
        if (tuple.version !== item.version || tuple.name !== item.name)
          fail('DB_REHEARSAL_VENDOR_HISTORY_MISMATCH');
        const migration = { ...item, statements: tuple.statements };
        assertMiniDbTupleSource(migration);
        return migration;
      });
    }
    (deps.assertTransition ?? assertMiniDbTransition)(before, after, migrations);
    const content = {
      ...plan,
      migrations,
      after,
      pgMajor: before.pgMajor,
      extensions: before.extensions
    };
    delete content.planDigest;
    const verified = { ...content, planDigest: dbValueDigest(content) };
    if (pending.length) {
      const localBinding = {
        kind: 'local-test',
        bindingId: 'local-mini-db',
        supabaseProject: 'local-mini-db',
        digest: dbValueDigest({ kind: 'local-test', sourceSha: plan.sourceSha })
      };
      const localContent = { ...content, bindingDigest: localBinding.digest };
      const localPlan = { ...localContent, planDigest: dbValueDigest(localContent) };
      await (deps.applyPlan ?? applyMiniDbPlan)({
        plan: localPlan,
        binding: localBinding,
        connectionString: runtime.urls.mini,
        journal: receipt =>
          (deps.persistReceipt ?? persistArtifact)(
            join(artifactDirectory, 'clone-journal'),
            receipt
          )
      });
      if (!same(await runtime.snapshot('mini'), after)) fail('DB_REHEARSAL_MINI_VENDOR_MISMATCH');
      const version = '99991231235959';
      if (sources.some(item => item.version >= version))
        fail('DB_REHEARSAL_INTEROP_VERSION_UNAVAILABLE');
      const sql = 'CREATE TABLE public.soty_mini_db_interop_probe (id bigint);';
      await runtime.push('mini', [
        ...sources,
        {
          version,
          name: 'mini_interop_probe',
          path: `supabase/migrations/${version}_mini_interop_probe.sql`,
          sourceDigest: hash(sql),
          sql
        }
      ]);
      const full = await runtime.snapshot('mini');
      if (
        full.history.length !== after.history.length + 1 ||
        dbValueDigest(full.history.slice(0, -1)) !== after.historyDigest ||
        full.history.at(-1)?.version !== version ||
        full.history.at(-1)?.name !== 'mini_interop_probe' ||
        !full.catalog.some(
          item =>
            item.kind === 'relation' &&
            item.schema === 'public' &&
            item.name === 'soty_mini_db_interop_probe'
        )
      )
        fail('DB_REHEARSAL_NEXT_FULL_CLI_FAILED');
      interoperability = 'verified';
    }
    const evidence = {
      schemaVersion: 1,
      sourceSha: plan.sourceSha,
      bindingDigest: binding.digest,
      planDigest: verified.planDigest,
      officialCliVersion: runtime.cliVersion,
      imageId: runtime.imageId,
      before: replayed,
      after,
      sources: sources.map(({ version, name, path, sourceDigest }) => ({
        version,
        name,
        path,
        sourceDigest
      })),
      canonicalTuples: migrations.map(({ version, name, statements, sourceDigest }) => ({
        version,
        name,
        statements,
        sourceDigest
      })),
      checks: {
        baseline: 'matched',
        miniVendor: pending.length ? 'matched' : 'not_needed',
        nextFullCli: interoperability,
        productSmoke: 'not_performed'
      }
    };
    result = {
      plan: verified,
      evidence,
      artifactPath: await (deps.persistArtifact ?? persistArtifact)(
        resolve(artifactDirectory),
        evidence
      )
    };
  } finally {
    await runtime.close();
  }
  return result;
}
