import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import { preflightLocal } from './preflight.mjs';
import { validateFixtureState, assertFixtureProvisionable } from './fixtures.mjs';
import { readPrivateState, writePrivateState } from './private-state.mjs';
import { readOptionalVariants } from './variants.mjs';

/** Bootstrap a separate local LOGIN that inherits only the canonical SELECT role. */
export async function prepareDiagnosticReader(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  await assertFixtureProvisionable(target.namespace);
  const readiness = await preflightLocal(target);
  if (!readiness.targetIdentityVerified) throw new Error('ACCEPTANCE_PREFLIGHT_FAILED');
  const role = `acceptance_ro_${createHash('sha256').update(target.namespace).digest('hex').slice(0, 12)}`;
  let reader;
  try {
    reader = await readPrivateState(target.namespace, 'reader.json');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    reader = { namespace: target.namespace, role, password: randomBytes(32).toString('hex') };
    await writePrivateState(target.namespace, 'reader.json', reader, { createOnly: true });
  }
  if (
    reader.namespace !== target.namespace ||
    reader.role !== role ||
    typeof reader.password !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reader.password)
  )
    throw new Error('ACCEPTANCE_READER_INVALID');
  const client = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  try {
    await client.query('begin');
    const held = await client.query(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) held',
      [`acceptance-fixtures:${target.namespace}`]
    );
    if (held.rows[0]?.held !== true) throw new Error('ACCEPTANCE_FIXTURE_BUSY');
    // A cleanup may have committed after preflight. Never recreate its revoked reader role.
    await assertFixtureProvisionable(target.namespace);
    const base = await client.query(
      "select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication from pg_roles where rolname='wishly_analytics_ro'"
    );
    if (base.rowCount !== 1 || Object.values(base.rows[0]).some(Boolean))
      throw new Error('ACCEPTANCE_READER_BASE_UNSAFE');
    const existing = await client.query('select rolname from pg_roles where rolname=$1', [role]);
    if (!existing.rowCount) {
      // Both literals are generated from bounded hex and validated above, never user SQL.
      await client.query(
        `create role ${role} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4 password '${reader.password}' in role wishly_analytics_ro`
      );
      await client.query(`alter role ${role} set default_transaction_read_only=on`);
      await client.query(`alter role ${role} set statement_timeout='30s'`);
    }
    const attributes = await client.query(
      'select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin,rolconnlimit,rolconfig from pg_roles where rolname=$1',
      [role]
    );
    const memberships = await client.query(
      'select parent.rolname, member.admin_option from pg_auth_members member join pg_roles parent on parent.oid=member.roleid join pg_roles child on child.oid=member.member where child.rolname=$1',
      [role]
    );
    if (!diagnosticRoleSafe(attributes.rows[0], memberships.rows))
      throw new Error('ACCEPTANCE_READER_UNSAFE');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
  const url = new URL(target.databaseUrl);
  url.username = role;
  url.password = reader.password;
  return { url: url.toString(), role };
}

export async function runLocalDiagnosis(target, command, alias) {
  if (
    !['audit', 'investigate', 'database-health', 'team-workspace', 'connection'].includes(command)
  )
    throw new Error('ACCEPTANCE_DIAGNOSTIC_COMMAND_INVALID');
  const reader = await prepareDiagnosticReader(target);
  const state = await readPrivateState(target.namespace, 'fixtures.json');
  if (!validateFixtureState(state, target.namespace).ok)
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const args = ['run', 'analytics', '--', command];
  if (command === 'investigate') {
    const variants = await readOptionalVariants(target.namespace);
    const actor = state.actors[alias] ?? variants?.actors[alias];
    if (!['A', 'B', 'C', 'X', 'S', 'SOLO', 'PENDING'].includes(alias) || !actor)
      throw new Error('ACCEPTANCE_ACTOR_INVALID');
    args.push(actor.email);
  } else if (alias !== undefined) throw new Error('ACCEPTANCE_DIAGNOSTIC_COMMAND_INVALID');
  args.push('--period', '30d', '--json');
  const result = spawnSync('npm', args, {
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ANALYTICS_DATABASE_URL: reader.url, ANALYTICS_DB_NO_SSL: '1' }
  });
  const marker = result.stdout?.indexOf('{');
  if (result.status !== 0 || marker === undefined || marker < 0)
    throw new Error('ACCEPTANCE_DIAGNOSTIC_FAILED');
  const output = JSON.parse(result.stdout.slice(marker));
  if (!output || output.ok !== true || output.command !== command)
    throw new Error('ACCEPTANCE_DIAGNOSTIC_FAILED');
  return output;
}

/** Refuse altered readers rather than silently repairing security-sensitive access. */
export function diagnosticRoleSafe(attributes, memberships) {
  if (
    !attributes ||
    ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls', 'rolreplication'].some(
      key => attributes[key] !== false
    )
  )
    return false;
  if (attributes.rolcanlogin !== true || attributes.rolconnlimit !== 4) return false;
  const settings = new Set(attributes.rolconfig ?? []);
  if (
    settings.size !== 2 ||
    !settings.has('default_transaction_read_only=on') ||
    !settings.has('statement_timeout=30s')
  )
    return false;
  return (
    memberships.length === 1 &&
    memberships[0].rolname === 'wishly_analytics_ro' &&
    memberships[0].admin_option === false
  );
}
