import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';
import { teardownFixtureTariffClock } from '../scripts/acceptance/clock-state.mjs';
import { waitFor } from './support/wait';

const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const connection = process.env.SOTY_TEST_POSTGRES_URL;
const sourceProject = process.env.SOTY_TEST_AUTH_SOURCE_PROJECT;
const suffix = container?.slice(-16) ?? randomBytes(8).toString('hex');
const authContainer = `soty-test-auth-${suffix}`;
const network = `soty-test-auth-net-${suffix}`;
const secret = randomBytes(32).toString('hex');
const docker = (args: string[], input?: string) => {
  try {
    return execFileSync('docker', args, {
      input,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    // Docker command errors may contain the disposable credential arguments.
    throw Error('ISOLATED_AUTH_DOCKER_FAILED');
  }
};
let admin: pg.Client | undefined;
let db: pg.Client | undefined;
let networkCreated = false;
let authCreated = false;
let authUrl = '';
let accessToken = '';
let actorId = '';
let fixtureSql = '';

/** Never print credentials or Auth response bodies on a failed probe. */
async function request(route: string, token?: string, body?: object) {
  if (
    !container ||
    !['/health', '/signup', '/user'].includes(route) ||
    authUrl !== `http://${authContainer}:9999`
  )
    throw Error('ISOLATED_AUTH_ROUTE_INVALID');
  // Internal Docker networks deliberately expose no host port. Send real HTTP from
  // the owned database container; credentials travel on stdin, never process arguments.
  const config = [
    `url = ${JSON.stringify(authUrl + route)}`,
    'silent',
    'show-error',
    'max-time = 5',
    'write-out = "\\n%{http_code}"',
    `request = "${body ? 'POST' : 'GET'}"`,
    ...(token ? [`header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`] : []),
    ...(body
      ? [
          'header = "Content-Type: application/json"',
          `data = ${JSON.stringify(JSON.stringify(body))}`
        ]
      : [])
  ].join('\n');
  const response = spawnSync('docker', ['exec', '-i', container, 'curl', '--config', '-'], {
    input: config,
    encoding: 'utf8',
    timeout: 7000,
    maxBuffer: 1024 * 1024
  });
  if (response.status !== 0 || response.error) throw Error('ISOLATED_AUTH_HTTP_UNAVAILABLE');
  const split = response.stdout.lastIndexOf('\n');
  const status = Number(response.stdout.slice(split + 1));
  if (split < 0 || status < 100 || status > 599) throw Error('ISOLATED_AUTH_HTTP_INVALID');
  return new Response(response.stdout.slice(0, split), { status });
}
function withExpiry(token: string, expiresAt: number) {
  const [header, encoded] = token.split('.');
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: expiresAt })).toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe.skipIf(!container && !connection)(
  '036 tariff clock with real isolated Auth [needs: disposable native PostgreSQL]',
  () => {
    beforeAll(async () => {
      assertDisposablePostgresContainer(container);
      if (!connection || !sourceProject || !/^[a-zA-Z0-9_-]+$/.test(sourceProject))
        throw Error('DISPOSABLE_AUTH_CONFIGURATION_REQUIRED');
      const url = new URL(connection);
      if (
        url.protocol !== 'postgresql:' ||
        url.hostname !== '127.0.0.1' ||
        url.username !== 'supabase_admin' ||
        !/^[a-f0-9]{48}$/.test(url.password) ||
        url.pathname !== '/postgres' ||
        url.search ||
        url.hash ||
        docker(['port', container, '5432/tcp']).trim() !== `127.0.0.1:${url.port}`
      )
        throw Error('DISPOSABLE_CONNECTION_REQUIRED');
      const image = docker([
        'inspect',
        '--format',
        '{{.Config.Image}}',
        `supabase_auth_${sourceProject}`
      ]).trim();
      if (!/^(?:public\.ecr\.aws|ghcr\.io)\/supabase\/gotrue:[a-zA-Z0-9._-]+$/.test(image))
        throw Error('LOCAL_AUTH_IMAGE_REQUIRED');
      // Version metadata only: no auth users, sessions, refresh tokens or role passwords.
      const versions = docker([
        'exec',
        `supabase_db_${sourceProject}`,
        'psql',
        '-X',
        '-A',
        '-t',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
        '-c',
        'select version from auth.schema_migrations order by version'
      ])
        .trim()
        .split('\n');
      // GoTrue retains the literal bootstrap version 00 alongside timestamp migrations.
      if (
        !versions.length ||
        versions.length > 1024 ||
        versions.some(value => !/^(?:00|[0-9]{14})$/.test(value))
      )
        throw Error('AUTH_SCHEMA_VERSION_METADATA_INVALID');
      admin = new pg.Client({ connectionString: connection, connectionTimeoutMillis: 5000 });
      await admin.connect();
      await admin.query("set statement_timeout='10s'");
      const empty = await admin.query('select count(*)::int n from auth.users');
      if (empty.rows[0].n !== 0) throw Error('AUTH_FIXTURE_MUST_BE_EMPTY');
      await admin.query(
        `alter role supabase_auth_admin password '${url.password}'; alter role supabase_auth_admin set search_path=auth; alter role postgres password '${url.password}'; grant usage,create on schema private to postgres; alter function private.tariff_now() owner to postgres;`
      );
      await admin.query(
        'insert into auth.schema_migrations(version) select unnest($1::varchar[]) on conflict do nothing',
        [versions]
      );
      url.username = 'postgres';
      db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
      await db.connect();
      fixtureSql = await readFile(
        new URL('../supabase/fixtures/acceptance-clock.sql', import.meta.url),
        'utf8'
      );
      docker([
        'network',
        'create',
        '--internal',
        '--label',
        `soty.acceptance.database=${container}`,
        network
      ]);
      networkCreated = true;
      docker(['network', 'connect', network, container]);
      const authDb = `postgresql://supabase_auth_admin:${url.password}@${container}:5432/postgres`;
      docker([
        'create',
        '--name',
        authContainer,
        '--label',
        `soty.acceptance.database=${container}`,
        '--network',
        network,
        '--env',
        'GOTRUE_API_HOST=0.0.0.0',
        '--env',
        'GOTRUE_API_PORT=9999',
        '--env',
        'API_EXTERNAL_URL=http://127.0.0.1:9999',
        '--env',
        'GOTRUE_SITE_URL=http://127.0.0.1:5175',
        '--env',
        'GOTRUE_DB_DRIVER=postgres',
        '--env',
        `GOTRUE_DB_DATABASE_URL=${authDb}`,
        '--env',
        `GOTRUE_JWT_SECRET=${secret}`,
        '--env',
        'GOTRUE_JWT_EXP=3600',
        '--env',
        'GOTRUE_JWT_AUD=authenticated',
        '--env',
        'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
        '--env',
        'GOTRUE_JWT_ADMIN_ROLES=service_role',
        '--env',
        'GOTRUE_DISABLE_SIGNUP=false',
        '--env',
        'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
        '--env',
        'GOTRUE_MAILER_AUTOCONFIRM=true',
        image
      ]);
      authCreated = true;
      docker(['start', authContainer]);
      const published = JSON.parse(
        docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', authContainer])
      );
      if (Object.values(published ?? {}).some(value => value !== null))
        throw Error('AUTH_MUST_NOT_PUBLISH_PORTS');
      authUrl = `http://${authContainer}:9999`;
      await waitFor(async () => (await request('/health')).ok, {
        timeoutMs: 30000,
        intervalMs: 250,
        describe: 'isolated Auth health'
      });
      const signup = await request('/signup', undefined, {
        email: `clock-${suffix}@soty.invalid`,
        password: randomBytes(24).toString('hex')
      });
      if (!signup.ok) throw Error('ISOLATED_SIGNUP_FAILED');
      const result = await signup.json();
      if (typeof result.access_token !== 'string' || typeof result.user?.id !== 'string')
        throw Error('ISOLATED_SESSION_MISSING');
      accessToken = result.access_token;
      actorId = result.user.id;
      await db.query(fixtureSql);
    }, 120000);

    afterAll(async () => {
      try {
        if (authCreated) {
          const logs = spawnSync('docker', ['logs', '--tail', '100', authContainer], {
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 1024 * 1024
          });
          const directory = 'release/acceptance-private/t011-auth';
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const raw = `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`;
          const redacted = raw
            .replaceAll(secret, '[disposable-secret]')
            .replaceAll(new URL(connection!).password, '[disposable-password]');
          await writeFile(`${directory}/auth-startup-${suffix}.log`, redacted, { mode: 0o600 });
          docker(['rm', '--force', '--volumes', authContainer]);
        }
        if (db) await teardownFixtureTariffClock(db, 'acceptance-auth-clock');
        if (admin && actorId) await admin.query('delete from auth.users where id=$1', [actorId]);
      } finally {
        await db?.end();
        await admin?.end();
        if (networkCreated) {
          if (container) docker(['network', 'disconnect', network, container]);
          docker(['network', 'rm', network]);
        }
      }
    }, 45000);

    it.each([-5, 5])(
      'keeps actual JWT validation on real time with tariff offset %iyears',
      async years => {
        const at = new Date();
        at.setUTCFullYear(at.getUTCFullYear() + years);
        await db!.query(
          `insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at)
        values(true,'acceptance-auth-clock',$1,clock_timestamp()+interval '1 minute')
        on conflict(singleton) do update set tariff_at=excluded.tariff_at,expires_at=excluded.expires_at`,
          [at]
        );
        const observed = (
          await db!.query('select private.tariff_now() as effective,now() as actual')
        ).rows[0];
        expect(new Date(observed.effective).toISOString()).toBe(at.toISOString());
        expect(Math.abs(new Date(observed.actual).getTime() - Date.now())).toBeLessThan(5000);
        const valid = await request('/user', accessToken);
        expect(valid.status).toBe(200);
        expect((await valid.json()).id).toBe(actorId);
        const expired = await request(
          '/user',
          withExpiry(accessToken, Math.floor(Date.now() / 1000) - 3600)
        );
        expect(expired.status).toBe(403);
        expect((await expired.json()).error_code).toBe('bad_jwt');
        const forged = `${accessToken.slice(0, accessToken.lastIndexOf('.') + 1)}invalid`;
        const rejected = await request('/user', forged);
        expect(rejected.status).toBe(403);
        expect((await rejected.json()).error_code).toBe('bad_jwt');
      }
    );
  }
);
