import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import { validateFixtureState } from './fixtures.mjs';
import { readPrivateState } from './private-state.mjs';
import { readOptionalVariants } from './variants.mjs';

/** Read-only live identity verification. Missing deployment digests remain explicit. */
export async function preflightLocal(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  const state = await readPrivateState(target.namespace, 'fixtures.json');
  if (!validateFixtureState(state, target.namespace).ok)
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const variants = await readOptionalVariants(target.namespace);
  const fixtureActors = [
    ...Object.entries(state.actors),
    ...Object.entries(variants?.actors ?? {})
  ];
  const status = JSON.parse(
    execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000
    })
  );
  if (status.API_URL !== target.authUrl || status.DB_URL !== target.databaseUrl)
    throw new Error('ACCEPTANCE_STACK_MISMATCH');
  const checks = [];
  let missingMigrations;
  const client = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000'
  });
  await client.connect();
  try {
    for (const [alias, actor] of fixtureActors) {
      const response = await fetch(`${target.authUrl}/auth/v1/admin/users/${actor.id}`, {
        headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      const user = response.ok ? await response.json() : null;
      const row = await client.query(
        "select id,raw_user_meta_data->>'acceptance_namespace' marker from auth.users where id=$1 and email=$2",
        [actor.id, actor.email]
      );
      checks.push({
        name: `auth-database-marker-${alias}`,
        ok:
          response.ok &&
          user?.id === actor.id &&
          user?.user_metadata?.acceptance_namespace === target.namespace &&
          row.rowCount === 1 &&
          row.rows[0].marker === target.namespace
      });
    }
    const schema = await client.query(
      'select version from supabase_migrations.schema_migrations where version=$1',
      ['20261206120000']
    );
    checks.push({ name: 'recovery-schema-version', ok: schema.rowCount === 1 });
    const journal = new Set(
      (await client.query('select version from supabase_migrations.schema_migrations')).rows.map(
        row => row.version
      )
    );
    const files = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(
      name => name.endsWith('.sql')
    );
    missingMigrations = files.filter(name => !journal.has(name.split('_')[0]));
    checks.push({ name: 'full-migration-journal', ok: missingMigrations.length === 0 });
  } finally {
    await client.end();
  }
  for (const name of ['team-recovery', 'team-invitations']) {
    try {
      const response = await fetch(`${target.functionsUrl}/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:5175',
          apikey: status.ANON_KEY,
          Authorization: `Bearer ${status.ANON_KEY}`
        },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      checks.push({
        name: `function-available-${name}`,
        ok: await functionProbeHealthy(response)
      });
    } catch {
      checks.push({ name: `function-available-${name}`, ok: false });
    }
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        kind: target.kind,
        namespace: target.namespace,
        auth: target.authUrl,
        functions: target.functionsUrl,
        db: '127.0.0.1:54322/postgres',
        actors: fixtureActors.map(([, actor]) => actor.id).sort()
      })
    )
    .digest('hex');
  return {
    ok: checks.every(check => check.ok),
    campaignId: target.namespace,
    targetFingerprint: fingerprint,
    checks,
    scope: 'local-fixture-readiness',
    targetIdentityVerified: checks
      .filter(check => check.name.startsWith('auth-database-marker-'))
      .every(check => check.ok),
    missingMigrations,
    finalCandidateReady: false,
    unknown: ['deployed-function-digests', 'hosted-capacity', 'packaged-exact-sha']
  };
}

/** A CORS/gateway rejection alone is not proof that the function module can serve. */
export async function functionProbeHealthy(response) {
  if (![400, 401, 403].includes(response.status)) return false;
  try {
    const body = await response.json();
    return (
      body?.ok === false &&
      ['AUTH_REQUIRED', 'INVALID_INPUT', 'PERMISSION_DENIED'].includes(body?.error?.code)
    );
  } catch {
    return false;
  }
}
