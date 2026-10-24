import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import { createActor } from './actors.mjs';
import { readPrivateState, writePrivateState } from './private-state.mjs';
import { parseEnvFile } from '../lib/env-file.mjs';
import { evaluateBetaEnvironment } from '../../packages/shared/dist/environment.js';

/** Local bootstrap privileges are never returned as actor credentials. No invitations are sent. */
export async function verifiedLocalStack(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  /** @type {Record<string, string>} */
  const profile = parseEnvFile(await readFile('.env.beta', 'utf8'));
  if (evaluateBetaEnvironment(profile).length) throw new Error('ACCEPTANCE_BETA_PROFILE_UNSAFE');
  const status = JSON.parse(
    execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000
    })
  );
  if (
    status.API_URL !== target.authUrl ||
    status.DB_URL !== target.databaseUrl ||
    typeof status.SERVICE_ROLE_KEY !== 'string' ||
    typeof status.ANON_KEY !== 'string'
  )
    throw new Error('ACCEPTANCE_STACK_MISMATCH');
  return status;
}

export async function provisionLocalFixtures(target) {
  const status = await verifiedLocalStack(target);
  await assertFixtureProvisionable(target.namespace);
  // A session lock spans Auth + database work; a crashed process releases it.
  const lock = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000
  });
  await lock.connect();
  try {
    const held = await lock.query('select pg_try_advisory_lock(hashtextextended($1,0)) held', [
      `acceptance-fixtures:${target.namespace}`
    ]);
    if (held.rows[0]?.held !== true) throw new Error('ACCEPTANCE_FIXTURE_BUSY');
    return await provisionVerifiedFixtures(target, status);
  } finally {
    await lock.end();
  }
}

async function provisionVerifiedFixtures(target, status) {
  await assertFixtureProvisionable(target.namespace);
  const privateDirectory = path.resolve('release/acceptance-private', target.namespace);
  const statePath = path.join(privateDirectory, 'fixtures.json');
  let state;
  try {
    state = await readPrivateState(target.namespace, 'fixtures.json');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    state = { namespace: target.namespace, actors: {}, teams: {} };
    for (const alias of ['A', 'B', 'C', 'X', 'S'])
      state.actors[alias] = {
        id: randomUUID(),
        email: `${target.namespace}-${alias.toLowerCase()}@soty.invalid`,
        password: randomBytes(24).toString('base64url'),
        provisioned: false
      };
    await writePrivateState(target.namespace, 'fixtures.json', state, { createOnly: true });
  }
  if (!validateFixtureState(state, target.namespace).ok)
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const save = () => writePrivateState(target.namespace, 'fixtures.json', state);
  for (const [alias, actor] of Object.entries(state.actors)) {
    if (actor.provisioned) continue;
    await ensureFixtureAuth(target, status, alias, actor);
    actor.provisioned = true;
    await save();
  }
  const client = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000
  });
  await client.connect();
  try {
    await client.query('begin');
    for (const actor of Object.values(state.actors)) {
      const check = await client.query(
        "select id from auth.users where id=$1 and email=$2 and raw_user_meta_data->>'acceptance_namespace'=$3",
        [actor.id, actor.email, target.namespace]
      );
      if (check.rowCount !== 1) throw new Error('ACCEPTANCE_AUTH_DATABASE_MISMATCH');
      await client.query(
        "update public.profiles set account_status='active',plan='pro' where id=$1",
        [actor.id]
      );
    }
    await client.query(
      'insert into public.admin_users(user_id) values($1) on conflict do nothing',
      [state.actors.S.id]
    );
    const normal = await client.query(
      'select count(*)::int n from public.admin_users where user_id=any($1::uuid[])',
      [['A', 'B', 'C', 'X'].map(alias => state.actors[alias].id)]
    );
    if (normal.rows[0].n !== 0) throw new Error('ACCEPTANCE_ACTOR_PRIVILEGED');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
  const actors = {};
  for (const [alias, actor] of Object.entries(state.actors)) {
    actors[alias] = await loginFixtureActor(target, status, actor);
  }
  const bootstrap = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000
  });
  await bootstrap.connect();
  try {
    for (const [alias, ownerAlias] of [
      ['W1', 'A'],
      ['W2', 'X']
    ]) {
      const name = `${target.namespace} ${alias}`;
      const owner = state.actors[ownerAlias];
      const existing = await bootstrap.query(
        `select id from public.teams where owner_id=$1 and name=$2 and status='active'`,
        [owner.id, name]
      );
      if (existing.rowCount === 1) state.teams[alias] = existing.rows[0].id;
      else {
        if (existing.rowCount !== 0) throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
        const pending = await bootstrap.query(
          'select id from public.space_tariffs where owner_id=$1 and team_id is null and revoked_at is null',
          [owner.id]
        );
        if (!pending.rowCount) {
          const grant = await actors.S.rpc('admin_grant_space_tariff', {
            p_email: owner.email,
            p_plan: 'lead',
            p_ends_on: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
            p_extra_seats: 0,
            p_notify: false,
            p_note: target.namespace
          });
          if (!grant.ok) throw new Error('ACCEPTANCE_TARIFF_GRANT_FAILED');
        }
        const created = await actors[ownerAlias].rpc('create_team', { p_name: name });
        if (!created.ok || !Array.isArray(created.data) || typeof created.data[0]?.id !== 'string')
          throw new Error('ACCEPTANCE_TEAM_CREATE_FAILED');
        state.teams[alias] = created.data[0].id;
      }
      await save();
    }
    // Seed baseline roles only. Invitation scenarios use actor actions separately.
    for (const [alias, role] of [
      ['B', 'editor'],
      ['C', 'viewer']
    ]) {
      const member = await bootstrap.query(
        'select id from public.team_members where team_id=$1 and user_id=$2',
        [state.teams.W1, state.actors[alias].id]
      );
      if (!member.rowCount)
        await bootstrap.query(
          `insert into public.team_members(team_id,user_id,base_role,status) values($1,$2,$3,'active')`,
          [state.teams.W1, state.actors[alias].id, role]
        );
    }
  } finally {
    await bootstrap.end();
  }
  return { state, actors, save, privateStatePath: statePath };
}

export function validateFixtureState(input, namespace) {
  const reject = () => ({ ok: false });
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.namespace !== namespace ||
    !input.actors ||
    typeof input.actors !== 'object' ||
    Array.isArray(input.actors) ||
    !input.teams ||
    typeof input.teams !== 'object' ||
    Array.isArray(input.teams)
  )
    return reject();
  if (
    Object.keys(input).some(key => !['namespace', 'actors', 'teams'].includes(key)) ||
    Object.keys(input.actors).sort().join(',') !== 'A,B,C,S,X'
  )
    return reject();
  for (const alias of ['A', 'B', 'C', 'X', 'S']) {
    const actor = input.actors[alias];
    if (
      !actor ||
      typeof actor !== 'object' ||
      Object.keys(actor).some(key => !['id', 'email', 'password', 'provisioned'].includes(key)) ||
      typeof actor.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(actor.id) ||
      actor.email !== `${namespace}-${alias.toLowerCase()}@soty.invalid` ||
      typeof actor.password !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(actor.password) ||
      typeof actor.provisioned !== 'boolean'
    )
      return reject();
  }
  if (new Set(Object.values(input.actors).map(actor => actor.id)).size !== 5) return reject();
  for (const [alias, id] of Object.entries(input.teams)) {
    if (
      !['W1', 'W2'].includes(alias) ||
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    )
      return reject();
  }
  if (new Set(Object.values(input.teams)).size !== Object.keys(input.teams).length) return reject();
  return { ok: true };
}

/** Caller has verified stack identity and closed namespace ownership. */
export async function ensureFixtureAuth(target, status, alias, actor) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  if (
    !['A', 'B', 'C', 'X', 'S', 'SOLO', 'PENDING'].includes(alias) ||
    typeof actor.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(actor.id) ||
    typeof actor.password !== 'string' ||
    !/^[A-Za-z0-9_-]{32}$/.test(actor.password) ||
    actor.email !== `${target.namespace}-${alias.toLowerCase()}@soty.invalid` ||
    typeof status.SERVICE_ROLE_KEY !== 'string' ||
    typeof status.ANON_KEY !== 'string' ||
    status.API_URL !== target.authUrl ||
    status.DB_URL !== target.databaseUrl
  )
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const adminHeaders = {
    apikey: status.ANON_KEY,
    Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
  const existing = await fetch(`${target.authUrl}/auth/v1/admin/users/${actor.id}`, {
    headers: adminHeaders,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (existing.ok) {
    const user = await existing.json();
    if (
      user.id !== actor.id ||
      user.email !== actor.email ||
      user.user_metadata?.acceptance_namespace !== target.namespace
    )
      throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  } else {
    if (existing.status !== 404) throw new Error('ACCEPTANCE_AUTH_UNAVAILABLE');
    const response = await fetch(`${target.authUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        id: actor.id,
        email: actor.email,
        password: actor.password,
        email_confirm: true,
        user_metadata: { full_name: `036 ${alias}`, acceptance_namespace: target.namespace }
      })
    });
    if (!response.ok) throw new Error('ACCEPTANCE_AUTH_CREATE_FAILED');
    const created = await response.json();
    if (created.id !== actor.id) throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  }
}

export async function loginFixtureActor(target, status, actor) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  if (
    status.API_URL !== target.authUrl ||
    status.DB_URL !== target.databaseUrl ||
    !['a', 'b', 'c', 'x', 's', 'solo', 'pending'].some(
      alias => actor.email === `${target.namespace}-${alias}@soty.invalid`
    )
  )
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const response = await fetch(`${target.authUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { apikey: status.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password: actor.password })
  });
  if (!response.ok) throw new Error('ACCEPTANCE_ACTOR_LOGIN_FAILED');
  const session = await response.json();
  if (
    session.user?.id !== actor.id ||
    session.user?.user_metadata?.acceptance_namespace !== target.namespace
  )
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  return createActor(target, {
    accessToken: session.access_token,
    publicKey: status.ANON_KEY,
    expectedSubject: actor.id
  });
}

export async function assertFixtureProvisionable(namespace) {
  let exists = false;
  try {
    await readPrivateState(namespace, 'cleanup.json');
    exists = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  if (exists) throw new Error('ACCEPTANCE_FIXTURE_CLEANUP_PENDING');
}
