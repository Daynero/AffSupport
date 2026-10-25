import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  analyseMiniDbSql,
  assertMiniDbSafety,
  assertMiniDbTransition,
  MiniDbPolicyError
} from './mini-db-policy.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TRANSACTION_MS = 30_000;
const TOTAL_MS = 120_000;
const RESERVE_MS = 5_000;

export class MiniDbError extends Error {
  /** @param {string} code @param {string} [dbOutcome]
   * @param {{pid:number,backendStart:string}|null} [session] @param {unknown} [sqlState] */
  constructor(code, dbOutcome = 'unknown', session = null, sqlState = null) {
    super(code);
    this.name = 'MiniDbError';
    this.code = code;
    this.dbOutcome = dbOutcome;
    this.session = session;
    this.sqlState =
      typeof sqlState === 'string' && /^[A-Z0-9]{5}$/u.test(sqlState) ? sqlState : null;
  }
}

/** @returns {never} */
function fail(code) {
  throw new MiniDbError(code);
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) fail('DB_VALUE_INVALID');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(item => canonical(item, seen));
  } else {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      fail('DB_VALUE_INVALID');
    }
    result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key], seen)])
    );
  }
  seen.delete(value);
  return result;
}

export function dbValueDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function descriptor(value) {
  return value && SHA.test(value.historyDigest) && SHA.test(value.catalogDigest);
}

export function validateMiniDbPlan(plan, binding) {
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    !COMMIT.test(plan.sourceSha) ||
    !COMMIT.test(plan.agentSha)
  ) {
    fail('DB_PLAN_INVALID');
  }
  if (!binding || !SHA.test(binding.digest) || plan.bindingDigest !== binding.digest) {
    fail('DB_BINDING_MISMATCH');
  }
  if (
    !descriptor(plan.before) ||
    !descriptor(plan.after) ||
    !Array.isArray(plan.migrations) ||
    plan.migrations.length > 32
  ) {
    fail('DB_PLAN_INVALID');
  }
  if (!plan.migrations.length && !same(plan.before, plan.after)) fail('DB_PLAN_INVALID');
  if (
    !Number.isInteger(plan.before.pgMajor) ||
    plan.before.pgMajor < 17 ||
    !Number.isInteger(plan.after.pgMajor) ||
    plan.after.pgMajor < 17
  )
    fail('DB_PG_MAJOR_UNSUPPORTED');
  const { planDigest, ...content } = plan;
  if (!SHA.test(planDigest) || dbValueDigest(content) !== planDigest)
    fail('DB_PLAN_DIGEST_MISMATCH');
  let previous = '';
  let batchBytes = 0;
  for (const item of plan.migrations) {
    if (
      !item ||
      !/^\d{14}$/.test(item.version) ||
      item.version <= previous ||
      typeof item.name !== 'string' ||
      !/^[a-zA-Z0-9_]+$/.test(item.name) ||
      !SHA.test(item.sourceDigest) ||
      !Array.isArray(item.statements) ||
      !item.statements.length ||
      item.statements.length > 128 ||
      item.statements.some(sql => typeof sql !== 'string' || !sql.trim() || sql.includes('\0'))
    ) {
      fail('DB_PLAN_INVALID');
    }
    previous = item.version;
    const migrationBytes = item.statements.reduce(
      (sum, sql) => sum + Buffer.byteLength(sql, 'utf8'),
      0
    );
    batchBytes += migrationBytes;
    if (migrationBytes > 2 * 1024 * 1024 || batchBytes > 8 * 1024 * 1024) fail('DB_PLAN_INVALID');
    let statementCount = 0;
    for (const statement of item.statements) {
      const checked = analyseMiniDbSql(statement);
      statementCount += checked.statements.length;
      if (!checked.ok || statementCount > 128) fail('DB_PLAN_SQL_UNSAFE');
    }
  }
  // Clone before any await: callers cannot change the approved tuple during execution.
  return JSON.parse(JSON.stringify(canonical(plan)));
}

/** Parse only known database endpoints; never pass URL query options through to pg. */
export function validateMiniDbTarget(binding, connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail('DB_TARGET_INVALID');
  }
  if (
    !binding ||
    !SHA.test(binding.digest) ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash
  ) {
    fail('DB_TARGET_INVALID');
  }
  let database;
  let user;
  let password;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    fail('DB_TARGET_INVALID');
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  if (
    [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length > 1 ||
    !password ||
    !user ||
    database.includes('/')
  ) {
    fail('DB_TARGET_INVALID');
  }
  const local = binding.kind === 'local-test';
  if (local) {
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
      !/^soty_mini_db_[a-z0-9_]+$/.test(database) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !['postgres'].includes(user) ||
      ![null, 'disable', 'verify-full'].includes(url.searchParams.get('sslmode'))
    )
      fail('DB_TARGET_INVALID');
  } else {
    const project = binding.supabaseProject;
    if (
      !/^[a-z0-9]{20}$/.test(project ?? '') ||
      port !== 5432 ||
      database !== 'postgres' ||
      ![null, 'verify-full'].includes(url.searchParams.get('sslmode'))
    )
      fail('DB_TARGET_INVALID');
    const direct = host === `db.${project}.supabase.co` && user === 'postgres';
    const pooler =
      /^(?:[a-z0-9-]+\.)+pooler\.supabase\.com$/.test(host) && user === `postgres.${project}`;
    if (!direct && !pooler) fail('DB_TARGET_INVALID');
  }
  return {
    host,
    port,
    database,
    user,
    password,
    ssl:
      local && url.searchParams.get('sslmode') !== 'verify-full'
        ? false
        : { rejectUnauthorized: true },
    application_name: 'soty-mini-db',
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    options: '-c timezone=UTC -c search_path=pg_catalog,public -c lock_timeout=2000'
  };
}

const SNAPSHOT_SQL = `/* mini-db:snapshot */
SELECT current_setting('server_version_num')::integer / 10000 AS "pgMajor",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.evtname,'event',e.evtevent,'tags',e.evttags,'enabled',e.evtenabled,'function',pg_catalog.quote_ident(n.nspname)||'.'||pg_catalog.quote_ident(p.proname)||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')','functionDefinition',pg_catalog.pg_get_functiondef(p.oid),'source',p.prosrc,'language',l.lanname,'securityDefiner',p.prosecdef,'owner',pg_catalog.pg_get_userbyid(e.evtowner),'functionOwner',pg_catalog.pg_get_userbyid(p.proowner)) ORDER BY e.evtname),'[]') FROM pg_catalog.pg_event_trigger e JOIN pg_catalog.pg_proc p ON p.oid=e.evtfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang) AS "eventTriggers",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('name', extname, 'version', extversion) ORDER BY extname), '[]') FROM pg_catalog.pg_extension) AS extensions,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statements',statements) ORDER BY version), '[]') FROM supabase_migrations.schema_migrations) AS history,
 (SELECT jsonb_build_object(
   'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum),'[]') FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='supabase_migrations.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped),
   'uniqueVersion',EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attname='version' WHERE i.indrelid='supabase_migrations.schema_migrations'::regclass AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum AND i.indpred IS NULL AND i.indexprs IS NULL),
   'triggers',(SELECT count(*)::integer FROM pg_catalog.pg_trigger WHERE tgrelid='supabase_migrations.schema_migrations'::regclass),
   'policies',(SELECT count(*)::integer FROM pg_catalog.pg_policy WHERE polrelid='supabase_migrations.schema_migrations'::regclass),
   'rls',(SELECT relrowsecurity OR relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='supabase_migrations.schema_migrations'::regclass),
   'kind',(SELECT relkind FROM pg_catalog.pg_class WHERE oid='supabase_migrations.schema_migrations'::regclass),
   'accessMethod',(SELECT am.amname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am am ON am.oid=c.relam WHERE c.oid='supabase_migrations.schema_migrations'::regclass),
   'rules',(SELECT count(*)::integer FROM pg_catalog.pg_rewrite WHERE ev_class='supabase_migrations.schema_migrations'::regclass),
   'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid,true),'versionOnly',cardinality(k.conkey)=1 AND k.conkey[1]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=k.conrelid AND attname='version'),'deferrable',k.condeferrable,'deferred',k.condeferred,'validated',k.convalidated) ORDER BY k.conname),'[]') FROM pg_catalog.pg_constraint k WHERE k.conrelid='supabase_migrations.schema_migrations'::regclass),
   'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'immediate',i.indimmediate,'versionOnly',i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=i.indrelid AND attname='version'),'expression',i.indexprs IS NOT NULL,'predicate',i.indpred IS NOT NULL,'method',am.amname,'opclassSchema',onsp.nspname,'opclass',op.opcname) ORDER BY c.relname),'[]') FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam JOIN pg_catalog.pg_opclass op ON op.oid=i.indclass[0] JOIN pg_catalog.pg_namespace onsp ON onsp.oid=op.opcnamespace WHERE i.indrelid='supabase_migrations.schema_migrations'::regclass)
 )) AS ledger,
 (SELECT coalesce(jsonb_agg(x.item ORDER BY x.item::text),'[]') FROM (
   SELECT jsonb_build_object('kind','schema','schema',n.nspname,'name',n.nspname,'definition',jsonb_build_object('owner',pg_catalog.pg_get_userbyid(n.nspowner),'acl',n.nspacl::text)) AS item FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','relation','schema',n.nspname,'name',c.relname,'definition',jsonb_build_object('kind',c.relkind,'accessMethod',(SELECT am.amname FROM pg_catalog.pg_am am WHERE am.oid=c.relam),'owner',pg_catalog.pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'persistence',c.relpersistence,'parents',(SELECT coalesce(jsonb_agg(pn.nspname||'.'||pc.relname ORDER BY pn.nspname,pc.relname),'[]') FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class pc ON pc.oid=h.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace WHERE h.inhrelid=c.oid),'children',(SELECT coalesce(jsonb_agg(cn.nspname||'.'||cc.relname ORDER BY cn.nspname,cc.relname),'[]') FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class cc ON cc.oid=h.inhrelid JOIN pg_catalog.pg_namespace cn ON cn.oid=cc.relnamespace WHERE h.inhparent=c.oid),'options',c.reloptions,'partition',pg_catalog.pg_get_expr(c.relpartbound,c.oid),'partitionKey',CASE WHEN c.relkind='p' THEN pg_catalog.pg_get_partkeydef(c.oid) END,'view',CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) END)) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','m','S','f')
   UNION ALL
   SELECT jsonb_build_object('kind','sequence','schema',n.nspname,'name',c.relname,'definition',jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'max',s.seqmax::text,'min',s.seqmin::text,'cache',s.seqcache::text,'cycle',s.seqcycle)) FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','column','schema',n.nspname,'name',c.relname||'.'||a.attname,'definition',jsonb_build_object('position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'typeSchema',tyn.nspname,'typeKind',ty.typtype,'btreeOpclasses',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',opn.nspname,'name',op.opcname) ORDER BY opn.nspname,op.opcname),'[]') FROM pg_catalog.pg_opclass op JOIN pg_catalog.pg_namespace opn ON opn.oid=op.opcnamespace JOIN pg_catalog.pg_am am ON am.oid=op.opcmethod WHERE op.opcdefault AND am.amname='btree' AND (op.opcintype=a.atttypid OR (ty.typname='varchar' AND tyn.nspname='pg_catalog' AND op.opcintype='pg_catalog.text'::regtype))),'nullable',NOT a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'collation',co.collname,'collationSchema',con.nspname,'acl',a.attacl::text)) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace con ON con.oid=co.collnamespace JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid JOIN pg_catalog.pg_namespace tyn ON tyn.oid=ty.typnamespace WHERE n.nspname IN ('public','private') AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f')
   UNION ALL
   SELECT jsonb_build_object('kind','constraint','schema',n.nspname,'name',coalesce(c.relname,t.typname)||'.'||k.conname,'definition',jsonb_build_object('sql',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_catalog.pg_class c ON c.oid=k.conrelid LEFT JOIN pg_catalog.pg_type t ON t.oid=k.contypid WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','index','schema',n.nspname,'name',c.relname,'definition',jsonb_build_object('sql',pg_catalog.pg_get_indexdef(c.oid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive)) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','routine','schema',n.nspname,'name',p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')','definition',jsonb_build_object('sql',CASE WHEN p.prokind<>'a' THEN pg_catalog.pg_get_functiondef(p.oid) END,'owner',pg_catalog.pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig)) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','trigger','schema',n.nspname,'name',c.relname||'.'||t.tgname,'definition',jsonb_build_object('sql',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND NOT t.tgisinternal
   UNION ALL
   SELECT jsonb_build_object('kind','policy','schema',n.nspname,'name',c.relname||'.'||p.polname,'definition',jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT array_agg(CASE WHEN r=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
   UNION ALL
   SELECT jsonb_build_object('kind','type','schema',n.nspname,'name',t.typname,'definition',jsonb_build_object('kind',t.typtype,'base',pg_catalog.format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault,'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid))) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','private') AND t.typtype IN ('e','d')
   UNION ALL
   SELECT jsonb_build_object('kind','defaultAcl','schema',n.nspname,'name',pg_catalog.pg_get_userbyid(a.defaclrole)||':'||a.defaclobjtype::text,'definition',a.defaclacl::text) FROM pg_catalog.pg_default_acl a JOIN pg_catalog.pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname IN ('public','private')
 ) x) AS catalog`;

export function validateMiniDbSnapshot(value) {
  if (
    !value ||
    !Number.isInteger(value.pgMajor) ||
    value.pgMajor < 14 ||
    !Array.isArray(value.extensions) ||
    !Array.isArray(value.eventTriggers) ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.history)
  )
    fail('DB_SNAPSHOT_INVALID');
  const ledger = value.ledger;
  if (
    !ledger ||
    ledger.kind !== 'r' ||
    ledger.accessMethod !== 'heap' ||
    ledger.uniqueVersion !== true ||
    ledger.rls !== false ||
    ledger.triggers !== 0 ||
    ledger.policies !== 0 ||
    ledger.rules !== 0 ||
    !Array.isArray(ledger.constraints) ||
    !Array.isArray(ledger.indexes) ||
    !ledger.indexes.length ||
    !Array.isArray(ledger.columns)
  )
    fail('DB_LEDGER_UNSUPPORTED');
  if (
    ledger.constraints.some(
      item =>
        !['p', 'u'].includes(item.kind) ||
        item.versionOnly !== true ||
        item.deferrable !== false ||
        item.deferred !== false ||
        item.validated !== true
    ) ||
    ledger.indexes.some(
      item =>
        item.unique !== true ||
        item.valid !== true ||
        item.ready !== true ||
        item.live !== true ||
        item.immediate !== true ||
        item.versionOnly !== true ||
        item.expression !== false ||
        item.predicate !== false ||
        item.method !== 'btree' ||
        item.opclassSchema !== 'pg_catalog' ||
        item.opclass !== 'text_ops'
    )
  )
    fail('DB_LEDGER_UNSUPPORTED');
  const columns = new Map(ledger.columns.map(column => [column.name, column]));
  const version = columns.get('version');
  if (
    columns.size !== ledger.columns.length ||
    !version ||
    !/^(?:text|character varying(?:\(\d+\))?)$/.test(version.type) ||
    columns.get('name')?.type !== 'text' ||
    columns.get('statements')?.type !== 'text[]'
  )
    fail('DB_LEDGER_UNSUPPORTED');
  for (const column of columns.values()) {
    if (
      column.identity ||
      column.generated ||
      column.default !== null ||
      (!['version', 'name', 'statements'].includes(column.name) && column.notNull)
    )
      fail('DB_LEDGER_UNSUPPORTED');
  }
  let previous = '';
  for (const row of value.history) {
    if (
      !row ||
      !/^\d+$/.test(row.version) ||
      row.version <= previous ||
      typeof row.name !== 'string' ||
      !Array.isArray(row.statements) ||
      row.statements.some(sql => typeof sql !== 'string')
    )
      fail('DB_HISTORY_UNSUPPORTED');
    previous = row.version;
  }
  if (value.extensions.some(e => !e || typeof e.name !== 'string' || typeof e.version !== 'string'))
    fail('DB_SNAPSHOT_INVALID');
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const catalog = canonical(value.catalog).sort((a, b) =>
    order(JSON.stringify(a), JSON.stringify(b))
  );
  const extensions = canonical(value.extensions).sort((a, b) => order(a.name, b.name));
  const eventTriggers = canonical(value.eventTriggers)
    .map(trigger => {
      if (
        typeof trigger.name !== 'string' ||
        typeof trigger.event !== 'string' ||
        !['O', 'D', 'R', 'A'].includes(trigger.enabled) ||
        (trigger.tags !== null &&
          (!Array.isArray(trigger.tags) || trigger.tags.some(tag => typeof tag !== 'string'))) ||
        ['function', 'functionDefinition', 'source', 'language', 'owner', 'functionOwner'].some(
          key => typeof trigger[key] !== 'string'
        ) ||
        typeof trigger.securityDefiner !== 'boolean'
      )
        fail('DB_SNAPSHOT_INVALID');
      if (trigger.tags) trigger.tags.sort(order);
      return trigger;
    })
    .sort((a, b) => order(a.name, b.name));
  return {
    schemaVersion: 1,
    pgMajor: value.pgMajor,
    extensions,
    eventTriggers,
    catalog,
    history: canonical(value.history),
    ledger: canonical(ledger),
    historyDigest: dbValueDigest(value.history),
    ledgerDigest: dbValueDigest(ledger),
    catalogDigest: dbValueDigest({
      pgMajor: value.pgMajor,
      extensions,
      eventTriggers,
      catalog,
      ledger: canonical(ledger)
    })
  };
}

export async function readMiniDbSnapshot(client) {
  try {
    // Catalog deparsers use namespace visibility. Pin it even on caller-owned
    // rehearsal connections so identical objects have identical descriptions.
    await client.query("SELECT pg_catalog.set_config('search_path','pg_catalog,public',false)");
    const result = await client.query(SNAPSHOT_SQL);
    return validateMiniDbSnapshot(result.rows[0]);
  } catch (error) {
    if (error instanceof MiniDbError) throw error;
    throw new MiniDbError('DB_SNAPSHOT_UNAVAILABLE');
  }
}

async function bounded(action, milliseconds, code) {
  if (!(milliseconds > 0)) fail(code);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new MiniDbError(code)),
          Math.max(1, Math.floor(milliseconds))
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeOwned(client) {
  if (!client) return true;
  try {
    await bounded(() => client.end(), 1_000, 'DB_CLOSE_TIMEOUT');
    return true;
  } catch {
    // Destroy only this client's socket; never terminate a backend by PID.
    try {
      client.connection?.stream?.destroy();
    } catch {
      /* Fresh observation decides outcome. */
    }
    return false;
  }
}

function same(snapshot, expected) {
  return (
    snapshot.historyDigest === expected.historyDigest &&
    snapshot.catalogDigest === expected.catalogDigest
  );
}

function defaultFactory(config) {
  return new pg.Client(config);
}

function validSession(session) {
  return (
    session &&
    Number.isInteger(session.pid) &&
    session.pid > 0 &&
    typeof session.backendStart === 'string' &&
    Number.isFinite(Date.parse(session.backendStart))
  );
}

/** @param {{plan:any,binding:any,connectionString:string,session:any,clientFactory?:(config:any)=>any,timeoutMs?:number}} options */
export async function reconcileMiniDbPlan({
  plan: input,
  binding,
  connectionString,
  session,
  clientFactory = defaultFactory,
  timeoutMs = 20_000
}) {
  const plan = validateMiniDbPlan(input, binding);
  const config = validateMiniDbTarget(binding, connectionString);
  if (!validSession(session)) fail('DB_SESSION_INVALID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOTAL_MS)
    return { dbOutcome: 'unknown', session };
  const deadline = performance.now() + timeoutMs;
  const time = maximum => Math.max(0, Math.min(maximum, deadline - performance.now()));
  const client = clientFactory({
    ...config,
    options: `${config.options} -c default_transaction_read_only=on`
  });
  let snapshot;
  try {
    await bounded(() => client.connect(), time(5_000), 'DB_OBSERVATION_TIMEOUT');
    const read = async (text, values = []) => {
      const budget = time(5_000);
      return bounded(
        () => client.query({ text, values, query_timeout: Math.max(1, Math.floor(budget)) }),
        budget,
        'DB_OBSERVATION_TIMEOUT'
      );
    };
    await read('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    snapshot = await readMiniDbSnapshot({ query: text => read(text) });
    const result = await bounded(
      () =>
        client.query({
          text: `/* mini-db:session-absence */ SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz) AS absent`,
          values: [session.pid, session.backendStart],
          query_timeout: 2_000
        }),
      time(2_000),
      'DB_OBSERVATION_TIMEOUT'
    );
    await read('COMMIT');
    if (same(snapshot, plan.after)) return { dbOutcome: 'committed', snapshot, session };
    if (same(snapshot, plan.before) && result.rows[0]?.absent === true)
      return { dbOutcome: 'aborted', snapshot, session };
    return { dbOutcome: 'unknown', snapshot, session };
  } catch {
    return { dbOutcome: 'unknown', session };
  } finally {
    await closeOwned(client);
  }
}

/** Exact approved vendor tuples, all in one transaction; never retries application SQL.
 * @param {{plan:any,binding:any,connectionString:string,clientFactory?:(config:any)=>any,journal?:(receipt:any)=>any,observe?:any,localTestBudgetMs?:number,budgets?:{transactionMs:number,totalMs:number,reserveMs:number,lockMs:number}}} options
 */
export async function applyMiniDbPlan({
  plan: input,
  binding,
  connectionString,
  clientFactory = defaultFactory,
  journal,
  observe,
  localTestBudgetMs,
  budgets
}) {
  const plan = validateMiniDbPlan(input, binding);
  const config = validateMiniDbTarget(binding, connectionString);
  if (!plan.migrations.length) fail('DB_NO_PENDING_MIGRATIONS');
  if (typeof journal !== 'function') fail('DB_DURABLE_JOURNAL_REQUIRED');
  const durableJournal = journal;
  if (observe !== undefined) fail('DB_OBSERVER_OVERRIDE_UNSUPPORTED');
  if ((localTestBudgetMs !== undefined || budgets !== undefined) && binding.kind !== 'local-test')
    fail('DB_BUDGET_OVERRIDE_FORBIDDEN');
  if (localTestBudgetMs !== undefined && budgets !== undefined) fail('DB_BUDGET_INVALID');
  if (budgets !== undefined && (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)))
    fail('DB_BUDGET_INVALID');
  if (
    localTestBudgetMs !== undefined &&
    (!Number.isInteger(localTestBudgetMs) ||
      localTestBudgetMs <= 0 ||
      localTestBudgetMs > TRANSACTION_MS)
  )
    fail('DB_BUDGET_INVALID');
  const limits =
    budgets !== undefined
      ? { ...budgets }
      : localTestBudgetMs === undefined
        ? {
            transactionMs: TRANSACTION_MS,
            totalMs: TOTAL_MS,
            reserveMs: RESERVE_MS,
            lockMs: 2000
          }
        : {
            transactionMs: localTestBudgetMs,
            totalMs: TOTAL_MS,
            reserveMs: Math.max(1, Math.min(250, Math.floor(localTestBudgetMs / 4))),
            lockMs: Math.min(2000, localTestBudgetMs)
          };
  if (
    Object.keys(limits).sort().join(',') !== 'lockMs,reserveMs,totalMs,transactionMs' ||
    Object.values(limits).some(value => !Number.isInteger(value) || value <= 0) ||
    limits.transactionMs > TRANSACTION_MS ||
    limits.totalMs > TOTAL_MS ||
    limits.reserveMs > RESERVE_MS ||
    limits.lockMs > 2000 ||
    limits.reserveMs >= limits.transactionMs ||
    limits.transactionMs > limits.totalMs
  )
    fail('DB_BUDGET_INVALID');
  const started = performance.now();
  const globalDeadline = started + limits.totalMs;
  const client = clientFactory({
    ...config,
    options: `${config.options} -c transaction_timeout=${limits.transactionMs} -c idle_in_transaction_session_timeout=${limits.transactionMs}`
  });
  let transactionDeadline = globalDeadline;
  let session = null;
  let transactionStarted = false;
  let committed = false;
  let commitAttempted = false;
  const remaining = (reserve = 0) => {
    const ms = Math.floor(
      Math.min(globalDeadline, transactionDeadline) - performance.now() - reserve
    );
    if (ms <= 0) fail('DB_DEADLINE_EXCEEDED');
    return ms;
  };
  const query = async (text, values = [], reserve = 0) => {
    const budget = remaining(reserve);
    // Each SET itself is bounded by the preceding server timeout plus the local deadline.
    await bounded(
      () =>
        client.query({
          text: "SELECT pg_catalog.set_config('statement_timeout',$1,true), pg_catalog.set_config('lock_timeout',$2,true)",
          values: [String(budget), String(Math.min(limits.lockMs, budget))],
          query_timeout: budget
        }),
      budget,
      'DB_DEADLINE_EXCEEDED'
    );
    const next = remaining(reserve);
    return bounded(
      () => client.query({ text, values, query_timeout: next }),
      next,
      'DB_DEADLINE_EXCEEDED'
    );
  };
  try {
    await bounded(() => client.connect(), Math.min(5_000, remaining()), 'DB_CONNECT_TIMEOUT');
    const identity = await bounded(
      () =>
        client.query(
          `/* mini-db:identity */ SELECT pg_backend_pid() AS pid, backend_start::text AS "backendStart",
           (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='transaction_timeout') AS "transactionTimeoutMs",
           (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') AS "idleTimeoutMs"
           FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()`
        ),
      Math.min(5_000, remaining()),
      'DB_SESSION_UNAVAILABLE'
    );
    const server = identity.rows[0];
    if (!validSession(server)) fail('DB_SESSION_INVALID');
    for (const value of [server.transactionTimeoutMs, server.idleTimeoutMs]) {
      if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !/^[0-9]+$/.test(value)) ||
        !Number.isInteger(Number(value)) ||
        Number(value) <= 0 ||
        Number(value) > limits.transactionMs
      ) {
        fail('DB_SERVER_DEADLINE_UNPROVEN');
      }
    }
    session = Object.freeze({ pid: server.pid, backendStart: server.backendStart });
    // A successful callback means the owner fsynced the prepared marker before SQL may change data.
    const digests = value => ({
      historyDigest: value.historyDigest,
      catalogDigest: value.catalogDigest
    });
    await bounded(
      () =>
        durableJournal({
          schemaVersion: 1,
          phase: 'prepared',
          planDigest: plan.planDigest,
          bindingDigest: plan.bindingDigest,
          session,
          before: digests(plan.before),
          after: digests(plan.after)
        }),
      remaining(),
      'DB_JOURNAL_TIMEOUT'
    );
    transactionDeadline = Math.min(globalDeadline, performance.now() + limits.transactionMs);
    await bounded(
      () =>
        client.query({ text: 'BEGIN ISOLATION LEVEL SERIALIZABLE', query_timeout: remaining() }),
      remaining(),
      'DB_DEADLINE_EXCEEDED'
    );
    transactionStarted = true;
    await query('SET LOCAL search_path = pg_catalog, public', [], limits.reserveMs);
    await query(
      'LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE',
      [],
      limits.reserveMs
    );
    const snapshotClient = { query: text => query(text, [], limits.reserveMs) };
    const before = await readMiniDbSnapshot(snapshotClient);
    if (!same(before, plan.before)) fail('DB_BEFORE_MISMATCH');
    assertMiniDbSafety(before, plan.migrations);
    const expectedHistory = [
      ...before.history,
      ...plan.migrations.map(({ version, name, statements }) => ({ version, name, statements }))
    ];
    if (
      before.history.some(row => row.version >= plan.migrations[0].version) ||
      dbValueDigest(expectedHistory) !== plan.after.historyDigest
    )
      fail('DB_PENDING_MISMATCH');
    for (const migration of plan.migrations) {
      for (const statement of migration.statements) await query(statement, [], limits.reserveMs);
      await query(
        'INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[])',
        [migration.version, migration.name, migration.statements],
        limits.reserveMs
      );
    }
    const after = await readMiniDbSnapshot({ query: text => query(text) });
    if (!same(after, plan.after)) fail('DB_AFTER_MISMATCH');
    assertMiniDbTransition(before, after, plan.migrations);
    commitAttempted = true;
    await query('COMMIT');
    committed = true;
  } catch (error) {
    if (transactionStarted && !committed && !commitAttempted) {
      try {
        await bounded(
          () => client.query({ text: 'ROLLBACK', query_timeout: 1_000 }),
          1_000,
          'DB_ROLLBACK_TIMEOUT'
        );
      } catch {
        /* Never infer outcome from rollback transport. */
      }
    }
    await closeOwned(client);
    if (!session)
      throw new MiniDbError(error instanceof MiniDbError ? error.code : 'DB_CONNECTION_FAILED');
    const outcome = await reconcileMiniDbPlan({
      plan,
      binding,
      connectionString,
      session,
      clientFactory,
      timeoutMs: Math.max(0, globalDeadline - performance.now())
    });
    if (outcome.dbOutcome === 'committed')
      return { ok: true, dbOutcome: 'adopted', snapshot: outcome.snapshot, session };
    throw new MiniDbError(
      error instanceof MiniDbError || error instanceof MiniDbPolicyError
        ? error.code
        : 'DB_APPLY_FAILED',
      outcome.dbOutcome,
      session,
      error && typeof error === 'object' && 'code' in error ? error.code : null
    );
  }
  await closeOwned(client);
  const outcome = await reconcileMiniDbPlan({
    plan,
    binding,
    connectionString,
    session,
    clientFactory,
    timeoutMs: Math.max(0, globalDeadline - performance.now())
  });
  if (outcome.dbOutcome !== 'committed')
    throw new MiniDbError('DB_POSTCOMMIT_UNKNOWN', 'unknown', session);
  return { ok: true, dbOutcome: 'committed', snapshot: outcome.snapshot, session };
}
