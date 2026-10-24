import { readFile } from 'node:fs/promises';
const REAL_BODY = 'select pg_catalog.now()';
const REAL_SQL = `create or replace function private.tariff_now() returns timestamptz
language sql stable security definer set search_path='' as $$ ${REAL_BODY} $$;
revoke all on function private.tariff_now() from public, anon, authenticated, service_role;`;
const normalize = value => value.trim().replace(/;$/u, '').trim();

export async function readClockFixtureSource() {
  const sql = await readFile(
    new URL('../../supabase/fixtures/acceptance-clock.sql', import.meta.url),
    'utf8'
  );
  const body = /as \$clock\$([\s\S]+)\$clock\$/u.exec(sql)?.[1];
  if (!body) throw Error('SOURCE');
  return { sql, body };
}

/** Caller owns a transaction. Use the same order as fixture provisioning/cleanup. */
export async function lockTariffClockMutation(db, namespace) {
  if (typeof namespace !== 'string' || !/^acceptance-[a-z0-9][a-z0-9-]{2,63}$/u.test(namespace))
    throw Error('NAMESPACE');
  const fixture = await db.query(
    'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as held',
    [`acceptance-fixtures:${namespace}`]
  );
  if (fixture.rows[0]?.held !== true) throw Error('BUSY');
  const clock = await db.query(
    "select pg_try_advisory_xact_lock(hashtextextended('acceptance-tariff-clock',0)) as held"
  );
  if (clock.rows[0]?.held !== true) throw Error('BUSY');
}

export async function inspectTariffClockState(db, namespace, body) {
  const identity = await db.query(
    "select current_user='postgres' and current_database()='postgres' as valid"
  );
  if (identity.rows[0]?.valid !== true) throw Error('IDENTITY');
  const exists = (
    await db.query("select to_regclass('private.acceptance_tariff_clock') is not null as exists")
  ).rows[0].exists;
  const functionRow = (
    await db.query(
      "select p.prosrc,p.prosecdef,p.provolatile,p.proconfig,pg_get_userbyid(p.proowner) as owner from pg_proc p where p.oid=to_regprocedure('private.tariff_now()')"
    )
  ).rows[0];
  if (!functionRow) {
    if (exists) throw Error('FOREIGN_OVERLAY');
    return 'not_installed';
  }
  if (
    !functionRow.prosecdef ||
    functionRow.provolatile !== 's' ||
    functionRow.owner !== 'postgres' ||
    JSON.stringify(functionRow.proconfig) !== JSON.stringify(['search_path=""'])
  )
    throw Error('SEAM');
  if (exists) {
    if (normalize(functionRow.prosrc) !== normalize(body)) throw Error('FOREIGN_OVERLAY');
    const shape = await db.query(
      "select c.relrowsecurity and c.relforcerowsecurity and pg_get_userbyid(c.relowner)='postgres' and (select count(*) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)=5 as valid from pg_class c where c.oid='private.acceptance_tariff_clock'::regclass"
    );
    if (shape.rows[0]?.valid !== true) throw Error('FOREIGN_OVERLAY');
    const columns = await db.query(
      "select array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) order by a.attnum) as names, bool_and(a.attnotnull) as required from pg_attribute a where a.attrelid='private.acceptance_tariff_clock'::regclass and a.attnum>0 and not a.attisdropped"
    );
    if (
      JSON.stringify(columns.rows[0]?.names) !==
        JSON.stringify([
          'singleton:boolean',
          'namespace:text',
          'tariff_at:timestamp with time zone',
          'expires_at:timestamp with time zone',
          'installed_at:timestamp with time zone'
        ]) ||
      columns.rows[0]?.required !== true
    )
      throw Error('FOREIGN_OVERLAY');
    // PG18 also stores NOT NULL in pg_constraint (contype n). The exact
    // columns and attnotnull were already checked above on both PG17 and PG18.
    // https://www.postgresql.org/docs/18/catalog-pg-constraint.html
    const extras = await db.query(
      "select not exists(select 1 from pg_trigger where tgrelid='private.acceptance_tariff_clock'::regclass and not tgisinternal) and not exists(select 1 from pg_constraint where conrelid='private.acceptance_tariff_clock'::regclass and contype not in ('p','c','n')) and not exists(select 1 from pg_constraint where conrelid='private.acceptance_tariff_clock'::regclass and not convalidated) and not exists(select 1 from pg_policy where polrelid='private.acceptance_tariff_clock'::regclass) as valid"
    );
    if (extras.rows[0]?.valid !== true) throw Error('FOREIGN_OVERLAY');
    const constraints = await db.query(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='private.acceptance_tariff_clock'::regclass and contype<>'n' order by definition"
    );
    const expectedConstraints = [
      "CHECK ((namespace ~ '^acceptance-[a-z0-9][a-z0-9-]{2,63}$'::text))",
      'CHECK (singleton)',
      'PRIMARY KEY (singleton)'
    ].sort();
    if (
      JSON.stringify(constraints.rows.map(row => row.definition).sort()) !==
      JSON.stringify(expectedConstraints)
    )
      throw Error('FOREIGN_OVERLAY');
    const defaults = await db.query(
      "select a.attname,pg_get_expr(d.adbin,d.adrelid) as definition from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid='private.acceptance_tariff_clock'::regclass order by a.attname"
    );
    if (
      JSON.stringify(defaults.rows) !==
      JSON.stringify([
        { attname: 'installed_at', definition: 'clock_timestamp()' },
        { attname: 'singleton', definition: 'true' }
      ])
    )
      throw Error('FOREIGN_OVERLAY');

    for (const role of ['anon', 'authenticated', 'service_role']) {
      const acl = await db.query(
        "select not has_table_privilege($1,'private.acceptance_tariff_clock','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as valid",
        [role]
      );
      if (acl.rows[0]?.valid !== true) throw Error('FOREIGN_OVERLAY');
    }

    const rows = (await db.query('select singleton,namespace from private.acceptance_tariff_clock'))
      .rows;
    if (rows.length !== 1 || rows[0].singleton !== true || rows[0].namespace !== namespace)
      throw Error('FOREIGN_OVERLAY');
  } else if (normalize(functionRow.prosrc) !== REAL_BODY) throw Error('SEAM');
  const permissions = await db.query(
    "select not has_function_privilege('anon','private.tariff_now()','execute') and not has_function_privilege('authenticated','private.tariff_now()','execute') and not has_function_privilege('service_role','private.tariff_now()','execute') as valid"
  );
  if (permissions.rows[0]?.valid !== true) throw Error('SEAM_ACL');

  return exists ? 'overlay' : 'real';
}

export async function restoreTariffClockState(db, state) {
  if (state === 'not_installed') return { state, restored: false };
  if (state === 'overlay') {
    await db.query(REAL_SQL);
    await db.query('drop table private.acceptance_tariff_clock');
  }
  if ((await db.query('select private.tariff_now()=now() as restored')).rows[0]?.restored !== true)
    throw Error('RESTORE');
  return { state: 'real', restored: true };
}

/**
 * Internal fixture-cleanup seam: caller already verified the local stack, fixture
 * receipt and empty graph and holds its namespace session lock on this connection.
 * Owns a short transaction; a failed deletion afterward safely leaves real time.
 */
export async function teardownFixtureTariffClock(db, namespace, { dryRun = false } = {}) {
  let committing = false;
  try {
    const { body } = await readClockFixtureSource();
    await db.query('begin');
    await db.query("set local statement_timeout='10s'");
    await lockTariffClockMutation(db, namespace);
    const state = await inspectTariffClockState(db, namespace, body);
    if (dryRun) {
      await db.query('rollback');
      return { state, willRestore: state === 'overlay', dryRun: true };
    }
    const result = await restoreTariffClockState(db, state);
    committing = true;
    await db.query('commit');
    return result;
  } catch {
    await db.query('rollback').catch(() => undefined);
    throw new Error(committing ? 'ACCEPTANCE_CLOCK_UNCONFIRMED' : 'ACCEPTANCE_CLOCK_REFUSED');
  }
}
