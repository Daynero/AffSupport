import { createHash } from 'node:crypto';
import pg from 'pg';
import { verifiedLocalStack, validateFixtureState } from './fixtures.mjs';
import { readOptionalVariants, validateVariantState } from './variants.mjs';
import { readPrivateState, writePrivateState } from './private-state.mjs';
import { inspectCleanupGraph } from './cleanup-graph.mjs';
import { diagnosticRoleSafe } from './diagnostics.mjs';
import { teardownFixtureTariffClock } from './clock-state.mjs';
import { inspectFaultCleanupGraph } from './fault-journal.mjs';

/** @param {any} variants Optional separately validated variant manifest. */
export function cleanupOwnership(namespace, baseline, variants = null) {
  if (
    typeof namespace !== 'string' ||
    !/^acceptance-[a-z0-9][a-z0-9-]{2,63}$/.test(namespace) ||
    !validateFixtureState(baseline, namespace).ok ||
    (variants && !validateVariantState(variants, namespace).ok)
  )
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const actors = Object.entries({ ...baseline.actors, ...variants?.actors }).map(
    ([alias, actor]) => ({
      alias,
      id: actor.id,
      email: actor.email,
      provisioned: actor.provisioned
    })
  );
  if (new Set(actors.map(a => a.id)).size !== actors.length)
    throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
  const definitions = [
    ['W1', 'A'],
    ['W2', 'X'],
    ...(variants
      ? [
          ['WSolo', 'SOLO'],
          ['WLegacy', 'B']
        ]
      : [])
  ];
  const teams = { ...baseline.teams, ...variants?.teams };
  return {
    namespace,
    actors,
    adminId: baseline.actors.S.id,
    expectedTeams: definitions.map(([alias, owner]) => {
      const ownerActor = actors.find(a => a.alias === owner);
      if (!ownerActor) throw new Error('ACCEPTANCE_FIXTURE_MISMATCH');
      return {
        alias,
        id: teams[alias] ?? null,
        name: `${namespace} ${alias}`,
        ownerId: ownerActor.id
      };
    })
  };
}

function receiptMatches(value, namespace, digest, aliases) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every(k =>
      [
        'schemaVersion',
        'namespace',
        'ownershipDigest',
        'phase',
        'startedAt',
        'authDeleted',
        'plan'
      ].includes(k)
    ) &&
    value.schemaVersion === 1 &&
    value.namespace === namespace &&
    value.ownershipDigest === digest &&
    ['planned', 'app-disabled-auth-pending', 'complete'].includes(value.phase) &&
    Array.isArray(value.authDeleted) &&
    value.authDeleted.every(a => aliases.includes(a)) &&
    new Set(value.authDeleted).size === value.authDeleted.length &&
    (value.phase !== 'complete' || value.authDeleted.length === aliases.length) &&
    (value.phase !== 'planned' || value.authDeleted.length === 0) &&
    typeof value.startedAt === 'string' &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    value.plan &&
    typeof value.plan === 'object' &&
    !Array.isArray(value.plan) &&
    Object.keys(value.plan).sort().join(',') === 'tariffIds,teamIds' &&
    ['teamIds', 'tariffIds'].every(
      k =>
        Array.isArray(value.plan[k]) &&
        value.plan[k].length <= 128 &&
        new Set(value.plan[k]).size === value.plan[k].length &&
        value.plan[k].every(
          id =>
            typeof id === 'string' &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
        )
    )
  );
}

/**
 * No provisioning on this path. Pending Auth deletion can resume after profiles are gone.
 * @param {any} target
 * @param {{dryRun?: boolean}} options
 * @param {typeof fetch} transport Controlled HTTP failure injection for regression tests only.
 */
export async function clearLocalFixtures(target, options = {}, transport = fetch) {
  const status = await verifiedLocalStack(target);
  const baseline = await readPrivateState(target.namespace, 'fixtures.json');
  const variants = await readOptionalVariants(target.namespace);
  const ownership = cleanupOwnership(target.namespace, baseline, variants);
  const digest = createHash('sha256').update(JSON.stringify(ownership)).digest('hex');
  let receipt;
  try {
    receipt = await readPrivateState(target.namespace, 'cleanup.json');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  if (
    receipt &&
    !receiptMatches(
      receipt,
      target.namespace,
      digest,
      ownership.actors.map(a => a.alias)
    )
  )
    throw new Error('ACCEPTANCE_CLEANUP_RECEIPT_INVALID');
  const db = new pg.Client({
    connectionString: target.databaseUrl,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=5000'
  });
  await db.connect();
  const headers = { apikey: status.ANON_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` };
  async function present(actor, allowMissing) {
    const response = await transport(`${target.authUrl}/auth/v1/admin/users/${actor.id}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    const rows = await db.query(
      "select id,email,raw_user_meta_data->>'acceptance_namespace' namespace from auth.users where id=$1",
      [actor.id]
    );
    if (response.status === 404 && rows.rowCount === 0 && allowMissing) return false;
    if (!response.ok || rows.rowCount !== 1)
      throw new Error('ACCEPTANCE_CLEANUP_IDENTITY_MISMATCH');
    const user = await response.json();
    if (
      user.id !== actor.id ||
      user.email !== actor.email ||
      user.user_metadata?.acceptance_namespace !== target.namespace ||
      rows.rows[0].email !== actor.email ||
      rows.rows[0].namespace !== target.namespace
    )
      throw new Error('ACCEPTANCE_CLEANUP_IDENTITY_MISMATCH');
    return true;
  }
  async function readerRole() {
    const role = `acceptance_ro_${createHash('sha256').update(target.namespace).digest('hex').slice(0, 12)}`;
    let state;
    try {
      state = await readPrivateState(target.namespace, 'reader.json');
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    }
    const attributes = await db.query(
      'select oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin,rolconnlimit,rolconfig from pg_roles where rolname=$1',
      [role]
    );
    if (!attributes.rowCount) return null;
    if (
      !state ||
      state.namespace !== target.namespace ||
      state.role !== role ||
      typeof state.password !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.password)
    )
      throw new Error('ACCEPTANCE_CLEANUP_READER_UNOWNED');
    const membership = await db.query(
      'select parent.rolname, member.admin_option from pg_auth_members member join pg_roles parent on parent.oid=member.roleid join pg_roles child on child.oid=member.member where child.rolname=$1',
      [role]
    );
    const owned = await db.query(
      "select exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=$1 and deptype='o') present",
      [attributes.rows[0].oid]
    );
    if (!diagnosticRoleSafe(attributes.rows[0], membership.rows) || owned.rows[0]?.present)
      throw new Error('ACCEPTANCE_CLEANUP_READER_UNOWNED');
    return role;
  }
  try {
    const lock = await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) held', [
      `acceptance-fixtures:${target.namespace}`
    ]);
    if (lock.rows[0]?.held !== true) throw new Error('ACCEPTANCE_FIXTURE_BUSY');
    for (const actor of ownership.actors) {
      const exists = await present(
        actor,
        !actor.provisioned || (!!receipt && receipt.phase !== 'planned')
      );
      if (exists && receipt?.authDeleted.includes(actor.alias))
        throw new Error('ACCEPTANCE_CLEANUP_IDENTITY_MISMATCH');
    }
    const reader = await readerRole();
    const inspectionOwnership = () => ({
      ...ownership,
      retiredTeamIds: receipt?.plan.teamIds ?? [],
      retiredTariffIds: receipt?.plan.tariffIds ?? []
    });
    const scopedFaults = await inspectFaultCleanupGraph(
      db,
      target.namespace,
      baseline,
      () => inspectCleanupGraph(db, inspectionOwnership()),
      options.dryRun === true
    );
    let plan = scopedFaults.cleanupGraph;
    if (!plan.ok)
      return {
        ok: false,
        namespace: target.namespace,
        scope: plan.scope,
        blockers: plan.blockers,
        blockerCount: plan.blockerCount,
        mutated: false
      };
    // The namespace session lock remains held through fault/clock teardown and Auth
    // deletion. Clock setters take that same lock before touching the overlay.
    const tariffClock = await teardownFixtureTariffClock(db, target.namespace, {
      dryRun: options.dryRun === true
    });
    if (options.dryRun)
      return {
        ok: true,
        dryRun: true,
        namespace: target.namespace,
        scope: plan.scope,
        counts: plan.counts,
        teams: plan.teamIds.length,
        tariffs: plan.tariffIds.length,
        actors: ownership.actors.length,
        readerRole: reader !== null,
        tariffClock,
        scopedFaults
      };
    const save = () => writePrivateState(target.namespace, 'cleanup.json', receipt);
    if (!receipt) {
      receipt = {
        schemaVersion: 1,
        namespace: target.namespace,
        ownershipDigest: digest,
        phase: 'planned',
        startedAt: new Date().toISOString(),
        authDeleted: [],
        plan: { teamIds: plan.teamIds, tariffIds: plan.tariffIds }
      };
      await writePrivateState(target.namespace, 'cleanup.json', receipt, { createOnly: true });
    }
    if (receipt.phase === 'planned') {
      await db.query('begin');
      try {
        await db.query('select id from auth.users where id=any($1::uuid[]) for update', [
          plan.actorIds
        ]);
        await db.query('select id from public.teams where id=any($1::uuid[]) for update', [
          plan.teamIds
        ]);
        plan = await inspectCleanupGraph(db, inspectionOwnership());
        if (!plan.ok) throw new Error('ACCEPTANCE_CLEANUP_SCOPE_CHANGED');
        // Receipt survives a lost commit response; repeating these exact deletes is idempotent.
        receipt.plan.teamIds = [...new Set([...receipt.plan.teamIds, ...plan.teamIds])];
        receipt.plan.tariffIds = [...new Set([...receipt.plan.tariffIds, ...plan.tariffIds])];
        await save();
        await db.query('delete from public.space_tariffs where id=any($1::uuid[])', [
          plan.tariffIds
        ]);
        await db.query('delete from public.teams where id=any($1::uuid[])', [plan.teamIds]);
        await db.query('delete from public.admin_users where user_id=any($1::uuid[])', [
          plan.actorIds
        ]);
        await db.query('delete from public.profiles where id=any($1::uuid[])', [plan.actorIds]);
        await db.query('commit');
      } catch (error) {
        await db.query('rollback');
        throw error;
      }
      receipt.phase = 'app-disabled-auth-pending';
      await save();
    }
    for (const actor of ownership.actors) {
      if (receipt.authDeleted.includes(actor.alias)) continue;
      const current = await inspectCleanupGraph(db, inspectionOwnership());
      if (!current.ok || current.teamIds.length || current.tariffIds.length)
        throw new Error('ACCEPTANCE_CLEANUP_SCOPE_CHANGED');
      if (await present(actor, true)) {
        const response = await transport(`${target.authUrl}/auth/v1/admin/users/${actor.id}`, {
          method: 'DELETE',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok && response.status !== 404)
          throw new Error('ACCEPTANCE_CLEANUP_AUTH_PENDING');
      }
      if (await present(actor, true)) throw new Error('ACCEPTANCE_CLEANUP_AUTH_PENDING');
      receipt.authDeleted.push(actor.alias);
      await save();
    }
    const final = await inspectCleanupGraph(db, inspectionOwnership());
    if (!final.ok || final.teamIds.length || final.tariffIds.length || final.counts.length)
      throw new Error('ACCEPTANCE_CLEANUP_SCOPE_CHANGED');
    if (reader) await db.query(`drop role ${reader}`);
    if (await readerRole()) throw new Error('ACCEPTANCE_CLEANUP_READER_UNOWNED');
    receipt.phase = 'complete';
    await save();
    return {
      ok: true,
      namespace: target.namespace,
      scope: 'empty-fixtures-only',
      confirmedAbsent: {
        teams: receipt.plan.teamIds.length,
        tariffs: receipt.plan.tariffIds.length,
        users: receipt.authDeleted.length
      },
      readerRoleAbsent: true,
      tariffClock,
      scopedFaults,
      retainedPrivateCheckpoint: true
    };
  } finally {
    await db.end();
  }
}
