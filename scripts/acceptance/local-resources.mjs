import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import { preflightLocal } from './preflight.mjs';
import { prepareDiagnosticReader, diagnosticRoleSafe } from './diagnostics.mjs';
import { resourceCounterDelta } from './resource-counters.mjs';

// Only this module can mint a sampler. JSON evidence is never an authorization handle.
const samplers = new WeakMap();
const counters = [
  'xact_commit',
  'xact_rollback',
  'blks_read',
  'blks_hit',
  'temp_bytes',
  'deadlocks'
];
const hash = value => createHash('sha256').update(value).digest('hex');
const unknown = reason => ({ status: 'unknown', reason });
function safeFailure(error) {
  if (
    error instanceof Error &&
    [
      'ACCEPTANCE_RESOURCE_BINDING_FAILED',
      'ACCEPTANCE_RESOURCE_READ_FAILED',
      'ACCEPTANCE_RESOURCE_CLOSED',
      'ACCEPTANCE_RESOURCE_EXPIRED'
    ].includes(error.message)
  )
    return error;
  return new Error('ACCEPTANCE_RESOURCE_READ_FAILED');
}
const epochPattern = /^[0-9]{1,12}(?:\.[0-9]{1,6})?$/u;
const identitySql = `select current_database() as database_name,
  (select oid::text from pg_database where datname=current_database()) as database_oid,
  extract(epoch from pg_postmaster_start_time())::text as boot,
  current_user as reader, current_setting('transaction_read_only') as read_only,
  (select json_build_object('rolsuper',rolsuper,'rolcreatedb',rolcreatedb,
    'rolcreaterole',rolcreaterole,'rolbypassrls',rolbypassrls,'rolreplication',rolreplication,
    'rolcanlogin',rolcanlogin,'rolconnlimit',rolconnlimit,'rolconfig',rolconfig)
    from pg_roles where rolname=current_user) as attributes,
  (select coalesce(json_agg(json_build_object('rolname',parent.rolname,
    'admin_option',member.admin_option)),'[]'::json)
    from pg_auth_members member join pg_roles parent on parent.oid=member.roleid
    join pg_roles child on child.oid=member.member where child.rolname=current_user) as memberships`;
const metricsSql = `select extract(epoch from stats_reset)::text as stats_reset,
  pg_database_size(current_database())::text as database_bytes,
  numbackends::text as connections, xact_commit::text, xact_rollback::text,
  blks_read::text, blks_hit::text, temp_bytes::text, deadlocks::text
  from pg_stat_database where datname=current_database()`;

function readinessSafe(readiness) {
  return (
    readiness?.ok === true &&
    readiness.targetIdentityVerified === true &&
    typeof readiness.targetFingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(readiness.targetFingerprint)
  );
}

function context(handle) {
  const state = samplers.get(handle);
  if (!state) throw new Error('ACCEPTANCE_RESOURCE_HANDLE_INVALID');
  if (state.closed) throw new Error('ACCEPTANCE_RESOURCE_CLOSED');
  if (performance.now() >= state.expiresAt) throw new Error('ACCEPTANCE_RESOURCE_EXPIRED');
  return state;
}

function sqlIdentity(row, role) {
  if (
    !row ||
    row.database_name !== 'postgres' ||
    row.reader !== role ||
    row.read_only !== 'on' ||
    typeof row.database_oid !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(row.database_oid) ||
    typeof row.boot !== 'string' ||
    !epochPattern.test(row.boot) ||
    !Array.isArray(row.memberships) ||
    !diagnosticRoleSafe(row.attributes, row.memberships)
  )
    throw new Error('ACCEPTANCE_RESOURCE_BINDING_FAILED');
  return hash(`${row.database_oid}:${row.boot}`);
}

async function queryReader(reader, expectedIdentity, collect = false) {
  const client = new pg.Client({
    connectionString: reader.url,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000'
  });
  let output;
  let failure;
  try {
    await client.connect();
    const result = await client.query(identitySql);
    if (result.rowCount !== 1) throw new Error('ACCEPTANCE_RESOURCE_BINDING_FAILED');
    const identity = sqlIdentity(result.rows[0], reader.role);
    if (expectedIdentity && identity !== expectedIdentity)
      throw new Error('ACCEPTANCE_RESOURCE_BINDING_FAILED');
    if (!collect) output = { identity, row: null };
    else {
      const metrics = await client.query(metricsSql);
      if (metrics.rowCount !== 1) throw new Error('ACCEPTANCE_RESOURCE_READ_FAILED');
      output = { identity, row: metrics.rows[0] };
    }
  } catch (error) {
    // A driver error can contain the connection string or server payload.
    failure = safeFailure(error);
  } finally {
    try {
      await client.end();
    } catch (error) {
      failure ??= safeFailure(error);
    }
  }
  if (failure) throw failure;
  if (!output) throw new Error('ACCEPTANCE_RESOURCE_READ_FAILED');
  return output;
}

/** Local SQL/Auth observations only. Function digests and hosted management remain
 * unverified; this API deliberately cannot mint a full acceptance/runtime binding.
 * Each sample rechecks actual fixture readiness and the dedicated reader identity.
 * @param {unknown} options
 */
export async function openLocalResourceSampler(target, options = {}) {
  if (!validateLocalTarget(target).ok) throw new Error('ACCEPTANCE_TARGET_UNSAFE');
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(key => !['ttlMs', 'maxSamples', 'minimumIntervalMs'].includes(key))
  )
    throw new Error('ACCEPTANCE_RESOURCE_OPTIONS_INVALID');
  const option = (key, fallback) =>
    Reflect.get(options, key) === undefined ? fallback : Reflect.get(options, key);
  const ttlMs = option('ttlMs', 60000);
  const maxSamples = option('maxSamples', 12);
  const minimumIntervalMs = option('minimumIntervalMs', 1000);
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > 300000 ||
    !Number.isInteger(maxSamples) ||
    maxSamples < 1 ||
    maxSamples > 60 ||
    !Number.isInteger(minimumIntervalMs) ||
    minimumIntervalMs < 1000 ||
    minimumIntervalMs > 60000
  )
    throw new Error('ACCEPTANCE_RESOURCE_OPTIONS_INVALID');
  // Retain a bounded copy so caller edits cannot redirect a verified handle.
  const fixedTarget = Object.freeze(
    Object.fromEntries(
      ['kind', 'environment', 'marker', 'namespace', 'authUrl', 'functionsUrl', 'databaseUrl'].map(
        key => [key, target[key]]
      )
    )
  );
  const startedAt = performance.now();
  try {
    const readiness = await preflightLocal(fixedTarget);
    if (!readinessSafe(readiness)) throw new Error('ACCEPTANCE_RESOURCE_BINDING_FAILED');
    const reader = await prepareDiagnosticReader(fixedTarget);
    const { identity } = await queryReader(reader, null);
    if (performance.now() >= startedAt + ttlMs) throw new Error('ACCEPTANCE_RESOURCE_EXPIRED');
    const handle = Object.freeze({});
    samplers.set(handle, {
      target: fixedTarget,
      reader,
      identity,
      targetFingerprint: readiness.targetFingerprint,
      expiresAt: startedAt + ttlMs,
      maxSamples,
      minimumIntervalMs,
      count: 0,
      previous: null,
      busy: false,
      closed: false
    });
    return handle;
  } catch (error) {
    throw safeFailure(error);
  }
}

function valueObservation(value) {
  if (value === null || value === undefined) return unknown('missing_measurement');
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    return unknown('invalid_measurement');
  return { status: 'observed', value };
}

export async function readLocalResourceSample(handle) {
  const state = context(handle);
  if (state.busy) throw new Error('ACCEPTANCE_RESOURCE_BUSY');
  if (state.count >= state.maxSamples) throw new Error('ACCEPTANCE_RESOURCE_LIMIT');
  if (state.previous && performance.now() - state.previous.at < state.minimumIntervalMs)
    throw new Error('ACCEPTANCE_RESOURCE_INTERVAL');
  state.busy = true;
  try {
    const readiness = await preflightLocal(state.target);
    context(handle);
    if (!readinessSafe(readiness) || readiness.targetFingerprint !== state.targetFingerprint)
      throw new Error('ACCEPTANCE_RESOURCE_BINDING_FAILED');
    const { row } = await queryReader(state.reader, state.identity, true);
    context(handle);
    const at = performance.now();
    const epoch =
      typeof row.stats_reset === 'string' && epochPattern.test(row.stats_reset)
        ? hash(`${state.targetFingerprint}:${state.identity}:${row.stats_reset}`)
        : null;
    const measurements = Object.fromEntries(
      counters.map(key => {
        const value = valueObservation(row[key]);
        const before = state.previous;
        const delta = !('value' in value)
          ? unknown(value.reason)
          : before
            ? resourceCounterDelta(
                { value: before.row[key], epoch: before.epoch },
                { value: row[key], epoch },
                at - before.at
              )
            : unknown('no_prior_sample');
        return [key, { value, delta }];
      })
    );
    state.previous = { at, row: Object.fromEntries(counters.map(key => [key, row[key]])), epoch };
    state.count += 1;
    return {
      observedAt: new Date().toISOString(),
      sample: state.count,
      observationScope: 'database-wide-including-sampler',
      binding: {
        scope: 'local-sql-auth-observation',
        targetFingerprint: state.targetFingerprint,
        fullAcceptanceBinding: false,
        functionDigests: 'unknown',
        management: 'unsupported_local'
      },
      counters: measurements,
      gauges: {
        databaseBytes: valueObservation(row.database_bytes),
        connections: valueObservation(row.connections),
        cpu: unknown('unsupported_local'),
        io: unknown('unsupported_local'),
        wal: unknown('unsupported_local'),
        quota: unknown('unsupported_local')
      }
    };
  } catch (error) {
    state.closed = true;
    throw safeFailure(error);
  } finally {
    state.busy = false;
  }
}

export function closeLocalResourceSampler(handle) {
  const state = samplers.get(handle);
  if (!state) throw new Error('ACCEPTANCE_RESOURCE_HANDLE_INVALID');
  state.closed = true;
}
