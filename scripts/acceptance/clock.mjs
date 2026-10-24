import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { validateLocalTarget } from './target.mjs';
import {
  verifiedLocalStack,
  validateFixtureState,
  assertFixtureProvisionable
} from './fixtures.mjs';
import { readPrivateState } from './private-state.mjs';
import {
  readClockFixtureSource,
  lockTariffClockMutation,
  inspectTariffClockState,
  restoreTariffClockState
} from './clock-state.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

export function validateClockInstant(instant, ttlMs) {
  return (
    typeof instant === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant) &&
    Number.isFinite(Date.parse(instant)) &&
    new Date(instant).toISOString() === instant &&
    Number.isSafeInteger(ttlMs) &&
    ttlMs >= 1000 &&
    ttlMs <= 3600000
  );
}

/** Strict positional CLI input; never infer a default instant or unbounded lifetime. */
export function parseClockAction(args) {
  if (args.length === 1 && args[0] === 'clear') return { kind: 'clear' };
  if (
    args.length !== 3 ||
    args[1] !== '--ttl-ms' ||
    !/^[1-9][0-9]{3,6}$/u.test(args[2]) ||
    !validateClockInstant(args[0], Number(args[2]))
  )
    return null;
  return { kind: 'set', instant: args[0], ttlMs: Number(args[2]) };
}

/** Local only, privileged fixture installation. Not exposed as a product RPC or HTTP option. */
export async function changeLocalTariffClock(target, action) {
  let db;
  let committing = false;
  try {
    if (
      !validateLocalTarget(target).ok ||
      !action ||
      !['set', 'clear'].includes(action.kind) ||
      Object.keys(action).some(key => !['kind', 'instant', 'ttlMs'].includes(key)) ||
      (action.kind === 'set' && !validateClockInstant(action.instant, action.ttlMs)) ||
      (action.kind === 'clear' && Object.keys(action).length !== 1)
    )
      throw Error('INVALID');
    // A source profile and the live stack must independently identify acceptance.
    const config = await readFile('supabase/config.toml', 'utf8');
    if (!/^project_id\s*=\s*"acceptance[a-z0-9-]*"\s*$/mu.test(config)) throw Error('PROJECT');
    await verifiedLocalStack(target);
    const fixture = await readPrivateState(target.namespace, 'fixtures.json');
    if (
      !validateFixtureState(fixture, target.namespace).ok ||
      !fixture.teams.W1 ||
      !fixture.teams.W2
    )
      throw Error('FIXTURE');
    const { sql, body } = await readClockFixtureSource();
    db = new pg.Client({ connectionString: target.databaseUrl, connectionTimeoutMillis: 5000 });
    await db.connect();
    await db.query('begin');
    await db.query("set local statement_timeout='10s'");
    await lockTariffClockMutation(db, target.namespace);
    if (action.kind === 'set') await assertFixtureProvisionable(target.namespace);
    for (const [alias, actor] of Object.entries(fixture.actors)) {
      const found = await db.query(
        'select exists(select 1 from auth.users where id=$1 and email=$2) as valid',
        [actor.id, `${target.namespace}-${alias.toLowerCase()}@soty.invalid`]
      );
      if (found.rows[0]?.valid !== true) throw Error('FIXTURE');
    }
    for (const [alias, owner] of [
      ['W1', 'A'],
      ['W2', 'X']
    ]) {
      const found = await db.query(
        'select exists(select 1 from public.teams where id=$1 and owner_id=$2 and name=$3) as valid',
        [fixture.teams[alias], fixture.actors[owner].id, `${target.namespace} ${alias}`]
      );
      if (found.rows[0]?.valid !== true) throw Error('FIXTURE');
    }
    const state = await inspectTariffClockState(db, target.namespace, body);
    if (state === 'not_installed') throw Error('SEAM');
    const exists = state === 'overlay';
    if (action.kind === 'clear') {
      await restoreTariffClockState(db, state);
      committing = true;
      await db.query('commit');
      return { ok: true, state: 'real', namespace: target.namespace, restored: true };
    }
    if (!exists) await db.query(sql);
    const row = (
      await db.query(
        `insert into private.acceptance_tariff_clock(singleton,namespace,tariff_at,expires_at)
values(true,$1,$2::timestamptz,clock_timestamp()+$3::bigint*interval '1 millisecond')
on conflict(singleton) do update set tariff_at=excluded.tariff_at,expires_at=excluded.expires_at
returning tariff_at,expires_at`,
        [target.namespace, action.instant, action.ttlMs]
      )
    ).rows[0];
    const observed = (await db.query('select private.tariff_now() as instant')).rows[0].instant;
    if (new Date(observed).toISOString() !== action.instant) throw Error('OBSERVATION');
    committing = true;
    await db.query('commit');
    return {
      ok: true,
      state: 'overlay',
      namespace: target.namespace,
      instant: new Date(row.tariff_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      fixtureSha256: digest(sql)
    };
  } catch {
    await db?.query('rollback').catch(() => undefined);
    return {
      ok: false,
      code: committing ? 'ACCEPTANCE_CLOCK_UNCONFIRMED' : 'ACCEPTANCE_CLOCK_REFUSED'
    };
  } finally {
    await db?.end().catch(() => undefined);
  }
}
