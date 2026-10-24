import { readFile } from 'node:fs/promises';
import { FAULT_MARKER } from './fault-model.mjs';

const relation = 'private.acceptance_scoped_faults';
const expected = 'pg_temp.acceptance_scoped_faults_expected';
const metadata = `select c.relpersistence persistence,jsonb_build_object(
 'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
 'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
 'marker',obj_description(c.oid,'pg_class'),'partition',c.relispartition,
 'options',coalesce(c.reloptions,array[]::text[]),
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
   from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(jsonb_build_array(x.contype,pg_get_constraintdef(x.oid),x.condeferrable,x.condeferred,x.convalidated) order by x.contype,pg_get_constraintdef(x.oid)) from pg_constraint x where x.conrelid=c.oid),
 'indexes',(select jsonb_agg(jsonb_build_array(i.indisprimary,i.indisunique,i.indisexclusion,i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,i.indkey::text) order by i.indisprimary,i.indkey::text) from pg_index i where i.indrelid=c.oid),
 'triggers',exists(select 1 from pg_trigger where tgrelid=c.oid and not tgisinternal),
 'policies',exists(select 1 from pg_policy where polrelid=c.oid),
 'rules',exists(select 1 from pg_rewrite where ev_class=c.oid),
 'inherits',exists(select 1 from pg_inherits where inhrelid=c.oid or inhparent=c.oid),
 'otherGrants',exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner),
 'columnGrants',exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) g where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and g.grantee<>c.relowner)
 ) shape from pg_class c where c.oid=$1::regclass`;

export async function readFaultFixtureSource() {
  const source = await readFile(
    new URL('../../supabase/fixtures/acceptance-faults.sql', import.meta.url),
    'utf8'
  );
  if (
    source.length > 32768 ||
    !/^create table private\.acceptance_scoped_faults \(/mu.test(source) ||
    !source.includes(FAULT_MARKER)
  )
    throw Error('ACCEPTANCE_FAULT_SOURCE_INVALID');
  return source;
}

/** Caller owns a transaction and its verified fixture namespace lock. No arbitrary SQL input.
 * Derive expected catalog metadata from the trusted DDL in a temporary relation,
 * so PG17/18 formatting and NOT NULL catalog differences are compared on the same server.
 */
export async function ensureFaultSchema(db, { create = false } = {}) {
  const identity = (
    await db.query("select current_user='postgres' and current_database()='postgres' valid")
  ).rows[0];
  if (identity?.valid !== true) throw Error('ACCEPTANCE_FAULT_IDENTITY_INVALID');
  const held = (
    await db.query(
      "select pg_try_advisory_xact_lock(hashtextextended('acceptance-scoped-fault-schema',0)) held"
    )
  ).rows[0];
  if (held?.held !== true) throw Error('ACCEPTANCE_FAULT_BUSY');
  const exists =
    (await db.query('select to_regclass($1) is not null present', [relation])).rows[0]?.present ===
    true;
  if (!exists && !create) return 'absent';
  const source = await readFaultFixtureSource();
  if (!exists) await db.query(source);
  const template = source
    .replaceAll(relation, expected)
    .replace('create table', 'create temporary table')
    .replace('\n);', '\n) on commit drop;');
  await db.query(`drop table if exists ${expected}`);
  await db.query(template);
  const actual = (await db.query(metadata, [relation])).rows[0];
  const wanted = (await db.query(metadata, [expected])).rows[0];
  if (
    actual?.persistence !== 'p' ||
    wanted?.persistence !== 't' ||
    actual?.shape?.marker !== FAULT_MARKER ||
    actual?.shape?.owner !== 'postgres' ||
    actual?.shape?.otherGrants !== false ||
    JSON.stringify(actual?.shape) !== JSON.stringify(wanted?.shape)
  )
    throw Error('ACCEPTANCE_FAULT_FOREIGN_SCHEMA');
  return exists ? 'verified' : 'installed';
}
