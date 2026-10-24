import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import {
  provisionLocalFixtures,
  ensureFixtureAuth,
  loginFixtureActor,
  assertFixtureProvisionable
} from './fixtures.mjs';
import { readPrivateState, writePrivateState } from './private-state.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateVariantState(input, namespace) {
  if (
    typeof namespace !== 'string' ||
    !/^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(namespace) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.schemaVersion !== 1 ||
    input.namespace !== namespace ||
    Object.keys(input).some(
      k => !['schemaVersion', 'namespace', 'actors', 'teams', 'tariffs'].includes(k)
    )
  )
    return { ok: false };
  if (
    !input.actors ||
    typeof input.actors !== 'object' ||
    Array.isArray(input.actors) ||
    Object.keys(input.actors).sort().join(',') !== 'PENDING,SOLO'
  )
    return { ok: false };
  for (const alias of ['SOLO', 'PENDING']) {
    const actor = input.actors[alias];
    if (
      !actor ||
      typeof actor !== 'object' ||
      Array.isArray(actor) ||
      Object.keys(actor).some(k => !['id', 'email', 'password', 'provisioned'].includes(k)) ||
      !UUID.test(actor.id) ||
      actor.email !== `${namespace}-${alias.toLowerCase()}@soty.invalid` ||
      typeof actor.password !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/.test(actor.password) ||
      typeof actor.provisioned !== 'boolean'
    )
      return { ok: false };
  }
  if (input.actors.SOLO.id === input.actors.PENDING.id) return { ok: false };
  /** @type {Array<[string, string[]]>} */
  const referenceFields = [
    ['teams', ['WSolo', 'WLegacy']],
    ['tariffs', ['Solo', 'PendingSolo']]
  ];
  for (const [field, allowed] of referenceFields) {
    const value = input[field];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(
        ([k, v]) => !allowed.includes(k) || typeof v !== 'string' || !UUID.test(v)
      ) ||
      new Set(Object.values(value)).size !== Object.keys(value).length
    )
      return { ok: false };
  }
  return { ok: true };
}

export function variantMembersMatch(rows, expected) {
  return (
    Array.isArray(rows) &&
    rows.length === expected.length &&
    expected.every(member =>
      rows.some(
        row =>
          row.user_id === member.userId &&
          row.base_role === member.role &&
          row.status === 'active' &&
          row.permission_overrides &&
          typeof row.permission_overrides === 'object' &&
          !Array.isArray(row.permission_overrides) &&
          Object.keys(row.permission_overrides).length === 0
      )
    )
  );
}

export function variantTariffMatches(row, options) {
  if (!row) return false;
  const now = options.now ?? Date.now();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(now));
  const part = type => parts.find(p => p.type === type)?.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const end = typeof row.ends_on === 'string' ? Date.parse(`${row.ends_on}T00:00:00Z`) : NaN;
  const start = Date.parse(row.starts_at);
  return (
    UUID.test(row.id) &&
    row.owner_id === options.owner.id &&
    row.owner_email === options.owner.email &&
    row.note === options.namespace &&
    row.granted_by === options.adminId &&
    row.team_id === options.binding &&
    row.plan_code === 'solo' &&
    row.extra_seats === 0 &&
    row.revoked_at === null &&
    row.source === 'manual' &&
    row.external_ref === null &&
    Number.isFinite(start) &&
    start <= now + 5000 &&
    Number.isFinite(end) &&
    new Date(end).toISOString().slice(0, 10) === row.ends_on &&
    row.ends_on >= day &&
    end <= Date.parse(`${day}T00:00:00Z`) + 31 * 86400000
  );
}

export async function readOptionalVariants(namespace) {
  let state;
  try {
    state = await readPrivateState(namespace, 'variants.json');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  if (!validateVariantState(state, namespace).ok) throw new Error('ACCEPTANCE_VARIANT_INVALID');
  return state;
}

/** Separate owners prevent a pending grant from binding to another fixture's wizard. */
export async function provisionLocalVariants(target) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  const baseline = await provisionLocalFixtures(target);
  const status = JSON.parse(
    execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000
    })
  );
  if (status.API_URL !== target.authUrl || status.DB_URL !== target.databaseUrl)
    throw new Error('ACCEPTANCE_STACK_MISMATCH');
  const db = new pg.Client({ connectionString: target.databaseUrl, connectionTimeoutMillis: 5000 });
  await db.connect();
  try {
    const held = await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) held', [
      `acceptance-fixtures:${target.namespace}`
    ]);
    if (held.rows[0]?.held !== true) throw new Error('ACCEPTANCE_FIXTURE_BUSY');
    await assertFixtureProvisionable(target.namespace);
    const legacy = await db.query(
      'select legacy_rule_enabled from public.tariff_settings where id=true'
    );
    // Never change a global switch to manufacture a successful fixture.
    if (legacy.rows[0]?.legacy_rule_enabled !== true)
      throw new Error('ACCEPTANCE_VARIANT_PRECONDITION');
    let state = await readOptionalVariants(target.namespace);
    if (!state) {
      state = { schemaVersion: 1, namespace: target.namespace, actors: {}, teams: {}, tariffs: {} };
      for (const alias of ['SOLO', 'PENDING'])
        state.actors[alias] = {
          id: randomUUID(),
          email: `${target.namespace}-${alias.toLowerCase()}@soty.invalid`,
          password: randomBytes(24).toString('base64url'),
          provisioned: false
        };
      await writePrivateState(target.namespace, 'variants.json', state, { createOnly: true });
    }
    if (
      Object.values(state.actors).some(actor =>
        Object.values(baseline.state.actors).some(base => base.id === actor.id)
      )
    )
      throw new Error('ACCEPTANCE_VARIANT_INVALID');
    const save = () => writePrivateState(target.namespace, 'variants.json', state);
    const actors = {};
    for (const [alias, actor] of Object.entries(state.actors)) {
      await ensureFixtureAuth(target, status, alias, actor);
      actor.provisioned = true;
      await save();
    }
    await db.query('begin');
    try {
      for (const actor of Object.values(state.actors)) {
        const owned = await db.query(
          "select id from auth.users where id=$1 and email=$2 and raw_user_meta_data->>'acceptance_namespace'=$3",
          [actor.id, actor.email, target.namespace]
        );
        if (owned.rowCount !== 1) throw new Error('ACCEPTANCE_AUTH_DATABASE_MISMATCH');
        const privileged = await db.query(
          'select user_id from public.admin_users where user_id=$1',
          [actor.id]
        );
        if (privileged.rowCount) throw new Error('ACCEPTANCE_ACTOR_PRIVILEGED');
        await db.query(
          "update public.profiles set account_status='active',plan='pro' where id=$1",
          [actor.id]
        );
      }
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
    for (const [alias, actor] of Object.entries(state.actors))
      actors[alias] = await loginFixtureActor(target, status, actor);
    async function grant(alias, key, binding) {
      const actor = state.actors[alias];
      const rows = await db.query(
        'select id,owner_id,owner_email::text,note,granted_by,team_id,plan_code,extra_seats,revoked_at,source,external_ref,starts_at::text,ends_on::text from public.space_tariffs where owner_id=$1 and revoked_at is null',
        [actor.id]
      );
      if (rows.rows.length > 1 || (state.tariffs[key] && rows.rows[0]?.id !== state.tariffs[key]))
        throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
      if (rows.rowCount === 1) {
        if (
          !variantTariffMatches(rows.rows[0], {
            namespace: target.namespace,
            owner: actor,
            adminId: baseline.state.actors.S.id,
            binding
          })
        )
          throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
        state.tariffs[key] = rows.rows[0].id;
      } else {
        if (binding !== null) throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
        const result = await baseline.actors.S.rpc('admin_grant_space_tariff', {
          p_email: actor.email,
          p_plan: 'solo',
          p_ends_on: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          p_extra_seats: 0,
          p_notify: false,
          p_note: target.namespace
        });
        if (!result.ok) throw new Error('ACCEPTANCE_TARIFF_GRANT_FAILED');
        const current = await db.query(
          'select id from public.space_tariffs where owner_id=$1 and revoked_at is null and team_id is null and plan_code=$2',
          [actor.id, 'solo']
        );
        if (current.rowCount !== 1) throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
        state.tariffs[key] = current.rows[0].id;
      }
      await save();
    }
    const soloName = `${target.namespace} WSolo`;
    const solo = await db.query(
      'select id from public.teams where owner_id=$1 and name=$2 and status=$3',
      [state.actors.SOLO.id, soloName, 'active']
    );
    if (solo.rows.length > 1 || (state.teams.WSolo && solo.rows[0]?.id !== state.teams.WSolo))
      throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
    if (solo.rowCount === 1) {
      const members = await db.query(
        'select user_id,base_role,status,permission_overrides from public.team_members where team_id=$1',
        [solo.rows[0].id]
      );
      if (!variantMembersMatch(members.rows, [{ userId: state.actors.SOLO.id, role: 'admin' }]))
        throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
    }
    await grant('SOLO', 'Solo', solo.rows[0]?.id ?? null);
    if (solo.rowCount === 1) state.teams.WSolo = solo.rows[0].id;
    else {
      const created = await actors.SOLO.rpc('create_team', { p_name: soloName });
      if (!created.ok || !Array.isArray(created.data) || !UUID.test(created.data[0]?.id))
        throw new Error('ACCEPTANCE_TEAM_CREATE_FAILED');
      state.teams.WSolo = created.data[0].id;
    }
    await save();
    await grant('PENDING', 'PendingSolo', null);
    // Legacy has no tariff. Only this explicit fixture contains global admin S.
    const legacyName = `${target.namespace} WLegacy`;
    await db.query('begin');
    try {
      const found = await db.query(
        'select id from public.teams where owner_id=$1 and name=$2 and status=$3',
        [baseline.state.actors.B.id, legacyName, 'active']
      );
      if (
        found.rows.length > 1 ||
        (state.teams.WLegacy && found.rows[0]?.id !== state.teams.WLegacy)
      )
        throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
      if (found.rowCount === 1) state.teams.WLegacy = found.rows[0].id;
      else {
        const created = await db.query(
          'insert into public.teams(name,owner_id) values($1,$2) returning id',
          [legacyName, baseline.state.actors.B.id]
        );
        state.teams.WLegacy = created.rows[0].id;
        await db.query(
          "insert into public.team_members(team_id,user_id,base_role) values($1,$2,'admin'),($1,$3,'viewer')",
          [state.teams.WLegacy, baseline.state.actors.B.id, baseline.state.actors.S.id]
        );
      }
      const tariffs = await db.query('select id from public.space_tariffs where team_id=$1', [
        state.teams.WLegacy
      ]);
      if (tariffs.rowCount) throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
      const members = await db.query(
        'select user_id,base_role,status,permission_overrides from public.team_members where team_id=$1',
        [state.teams.WLegacy]
      );
      if (
        !variantMembersMatch(members.rows, [
          { userId: baseline.state.actors.B.id, role: 'admin' },
          { userId: baseline.state.actors.S.id, role: 'viewer' }
        ])
      )
        throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
    await save();
    const soloMembers = await db.query(
      'select user_id,base_role,status,permission_overrides from public.team_members where team_id=$1',
      [state.teams.WSolo]
    );
    if (!variantMembersMatch(soloMembers.rows, [{ userId: state.actors.SOLO.id, role: 'admin' }]))
      throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
    for (const [alias, key, binding] of [
      ['SOLO', 'Solo', state.teams.WSolo],
      ['PENDING', 'PendingSolo', null]
    ]) {
      const rows = await db.query(
        'select id,owner_id,owner_email::text,note,granted_by,team_id,plan_code,extra_seats,revoked_at,source,external_ref,starts_at::text,ends_on::text from public.space_tariffs where id=$1',
        [state.tariffs[key]]
      );
      if (
        rows.rowCount !== 1 ||
        !variantTariffMatches(rows.rows[0], {
          namespace: target.namespace,
          owner: state.actors[alias],
          adminId: baseline.state.actors.S.id,
          binding
        })
      )
        throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
    }
    const soloAccess = await actors.SOLO.rpc('get_team_tariff', { p_team: state.teams.WSolo });
    const pendingAccess = await actors.PENDING.rpc('get_my_space_access', {});
    const legacyAccess = await baseline.actors.B.rpc('get_team_tariff', {
      p_team: state.teams.WLegacy
    });
    const checks = {
      solo:
        soloAccess.ok &&
        soloAccess.data?.planCode === 'solo' &&
        soloAccess.data?.seatsTotal === 1 &&
        soloAccess.data?.seatsUsed === 1 &&
        soloAccess.data?.canInvite === false,
      pending:
        pendingAccess.ok &&
        pendingAccess.data?.canCreate === true &&
        pendingAccess.data?.pendingTariff?.planCode === 'solo' &&
        Array.isArray(pendingAccess.data?.teams) &&
        pendingAccess.data.teams.length === 0,
      legacy: legacyAccess.ok && legacyAccess.data?.state === 'legacy'
    };
    if (!Object.values(checks).every(Boolean)) throw new Error('ACCEPTANCE_VARIANT_STATE_CHANGED');
    return {
      namespace: target.namespace,
      fixtureVersion: 'local-fixtures-v2-variants',
      teams: state.teams,
      pendingTariff: state.tariffs.PendingSolo,
      checks
    };
  } finally {
    await db.end();
  }
}
