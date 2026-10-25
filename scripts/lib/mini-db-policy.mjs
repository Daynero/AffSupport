import { createHash } from 'node:crypto';

const SOURCE_BYTES = 2 * 1024 * 1024;
const BATCH_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATIONS = 32;
const MAX_STATEMENTS = 128;
const MAX_TOKENS = 16_384;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATION_PATH = /^supabase\/migrations\/([0-9]{14})_([a-z][a-z0-9_]{0,99})\.sql$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SIMPLE_TYPES = new Map([
  ['text', 'text'],
  ['bool', 'bool'],
  ['boolean', 'bool'],
  ['smallint', 'int2'],
  ['int2', 'int2'],
  ['integer', 'int4'],
  ['int', 'int4'],
  ['int4', 'int4'],
  ['bigint', 'int8'],
  ['int8', 'int8'],
  ['uuid', 'uuid'],
  ['jsonb', 'jsonb'],
  ['bytea', 'bytea'],
  ['date', 'date'],
  ['real', 'float4'],
  ['float4', 'float4'],
  ['float8', 'float8']
]);

export class MiniDbPolicyError extends Error {
  /** @param {string} code @param {number|null} [statementIndex] */
  constructor(code, statementIndex = null) {
    super(code);
    this.name = 'MiniDbPolicyError';
    this.code = code;
    this.statementIndex = statementIndex;
  }
}

const digest = sql => createHash('sha256').update(sql, 'utf8').digest('hex');
/** @param {string} code @param {number|null} [index] @returns {never} */
function fail(code, index = null) {
  throw new MiniDbPolicyError(code, index);
}

function checkComment(comment, index) {
  if (
    /\b(?:pg-delta|goose|migrate|migration|supabase)\s*[:+]/iu.test(comment) ||
    /\btransaction\s*[:=]/iu.test(comment) ||
    /\bno[-_ ]?transaction\b/iu.test(comment) ||
    /^\s*[+\\]/mu.test(comment)
  )
    fail('DB_MINI_COMMENT_DIRECTIVE', index);
}

/** A lexer for the closed DDL grammar below, never a general SQL statement splitter. */
function lex(sql) {
  if (typeof sql !== 'string' || !sql.length) fail('DB_MINI_SQL_EMPTY');
  if (Buffer.byteLength(sql, 'utf8') > SOURCE_BYTES) fail('DB_MINI_SOURCE_TOO_LARGE');
  if (sql.includes(String.fromCharCode(0))) fail('DB_MINI_SQL_TOKEN_UNSUPPORTED');
  const statements = [];
  let tokens = [];
  let tokenCount = 0;
  let start = 0;
  let cursor = 0;
  const append = value => {
    if (++tokenCount > MAX_TOKENS) fail('DB_MINI_SQL_TOO_COMPLEX', statements.length);
    tokens.push(value);
  };
  const statement = end => {
    if (!tokens.length) fail('DB_MINI_SQL_EMPTY_STATEMENT', statements.length);
    if (statements.length >= MAX_STATEMENTS) fail('DB_MINI_SQL_TOO_COMPLEX', statements.length);
    statements.push({ raw: sql.slice(start, end), tokens });
    tokens = [];
    start = end;
  };
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (/[ \t\r\n\f]/u.test(char)) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith('--', cursor)) {
      let next = cursor + 2;
      // PostgreSQL terminates a line comment on CR as well as LF.
      while (next < sql.length && sql[next] !== '\r' && sql[next] !== '\n') next += 1;
      checkComment(sql.slice(cursor + 2, next), statements.length);
      cursor = next;
      continue;
    }
    if (sql.startsWith('/*', cursor)) {
      const commentStart = cursor;
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
        if (depth > 32) fail('DB_MINI_SQL_TOO_COMPLEX', statements.length);
      }
      if (depth) fail('DB_MINI_COMMENT_UNTERMINATED', statements.length);
      checkComment(sql.slice(commentStart + 2, cursor - 2), statements.length);
      continue;
    }
    if (char === ';') {
      statement(cursor + 1);
      cursor += 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(sql.slice(cursor));
      if (!match) fail('DB_MINI_SQL_TOKEN_UNSUPPORTED', statements.length);
      append(match[0].toLowerCase());
      cursor += match[0].length;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const match = /^[0-9]+/u.exec(sql.slice(cursor));
      if (!match) fail('DB_MINI_SQL_TOKEN_UNSUPPORTED', statements.length);
      append(match[0]);
      cursor += match[0].length;
      continue;
    }
    if ('.(),[]'.includes(char)) {
      append(char);
      cursor += 1;
      continue;
    }
    // Quotes, dollar bodies, psql commands, operators and non-ASCII identifiers
    // are deliberately outside this first migration policy.
    fail('DB_MINI_SQL_TOKEN_UNSUPPORTED', statements.length);
  }
  if (tokens.length) statement(sql.length);
  if (!statements.length) fail('DB_MINI_SQL_EMPTY');
  return statements;
}

function parseType(tokens) {
  let index = 0;
  const word = tokens[index++];
  let baseType = SIMPLE_TYPES.get(word);
  const typeModifiers = [];
  if (word === 'double' && tokens[index] === 'precision') {
    baseType = 'float8';
    index += 1;
  }
  if (word === 'character' && tokens[index] === 'varying') {
    baseType = 'varchar';
    index += 1;
  }
  if (word === 'varchar') baseType = 'varchar';
  if (['numeric', 'decimal'].includes(word)) baseType = 'numeric';
  if (['timestamp', 'timestamptz', 'time', 'timetz'].includes(word)) baseType = word;
  if (!baseType) return null;
  if (tokens[index] === '(') {
    if (!['varchar', 'numeric', 'timestamp', 'timestamptz', 'time', 'timetz'].includes(baseType))
      return null;
    index += 1;
    if (!/^[0-9]+$/u.test(tokens[index] ?? '')) return null;
    typeModifiers.push(Number(tokens[index++]));
    if (tokens[index] === ',') {
      if (baseType !== 'numeric') return null;
      index += 1;
      if (!/^[0-9]+$/u.test(tokens[index] ?? '')) return null;
      typeModifiers.push(Number(tokens[index++]));
    }
    if (tokens[index++] !== ')') return null;
    if (typeModifiers.some(value => !Number.isSafeInteger(value))) return null;
    const [precision, scale = 0] = typeModifiers;
    if (baseType === 'varchar' && (precision < 1 || precision > 10_485_760)) return null;
    if (baseType === 'numeric' && (precision < 1 || precision > 1000 || scale > precision))
      return null;
    if (['timestamp', 'timestamptz', 'time', 'timetz'].includes(baseType) && precision > 6)
      return null;
  }
  if (['timestamp', 'time'].includes(word) && ['with', 'without'].includes(tokens[index])) {
    const zone = tokens[index++];
    if (tokens[index++] !== 'time' || tokens[index++] !== 'zone') return null;
    if (zone === 'with') baseType = word === 'time' ? 'timetz' : 'timestamptz';
  }
  let array = false;
  if (tokens[index] === '[' && tokens[index + 1] === ']') {
    array = true;
    index += 2;
  }
  if (index !== tokens.length) return null;
  return {
    type: tokens
      .join(' ')
      .replaceAll(' ( ', '(')
      .replaceAll(' )', ')')
      .replaceAll(' , ', ',')
      .replaceAll(' [ ]', '[]'),
    baseType,
    typeModifiers,
    array
  };
}

function operation(tokens) {
  if (
    tokens.slice(0, 3).join(' ') === 'alter table public' &&
    tokens[3] === '.' &&
    IDENTIFIER.test(tokens[4] ?? '') &&
    tokens[5] === 'add' &&
    tokens[6] === 'column' &&
    IDENTIFIER.test(tokens[7] ?? '')
  ) {
    const type = parseType(tokens.slice(8));
    return type
      ? { kind: 'add-column', schema: 'public', table: tokens[4], column: tokens[7], ...type }
      : null;
  }
  if (
    tokens[0] !== 'create' ||
    tokens[1] !== 'index' ||
    !IDENTIFIER.test(tokens[2] ?? '') ||
    tokens[3] !== 'on' ||
    tokens[4] !== 'public' ||
    tokens[5] !== '.' ||
    !IDENTIFIER.test(tokens[6] ?? '')
  )
    return null;
  let index = 7;
  if (tokens[index] === 'using') {
    if (tokens[index + 1] !== 'btree') return null;
    index += 2;
  }
  if (tokens[index++] !== '(') return null;
  const columns = [];
  for (;;) {
    if (!IDENTIFIER.test(tokens[index] ?? '')) return null;
    columns.push(tokens[index++]);
    if (tokens[index] !== ',') break;
    index += 1;
  }
  if (
    !columns.length ||
    columns.length > 32 ||
    new Set(columns).size !== columns.length ||
    tokens[index++] !== ')' ||
    index !== tokens.length
  )
    return null;
  return { kind: 'create-index', schema: 'public', table: tokens[6], name: tokens[2], columns };
}

/** Only metadata-only public nullable-column additions and ordinary btree indexes qualify. */
export function analyseMiniDbSql(sql) {
  let parsed;
  try {
    parsed = lex(sql);
  } catch (error) {
    if (!(error instanceof MiniDbPolicyError)) throw error;
    return {
      ok: false,
      statements: [],
      operations: [],
      blockers: [{ code: error.code, statementIndex: error.statementIndex }]
    };
  }
  const operations = [];
  const blockers = [];
  parsed.forEach((entry, statementIndex) => {
    const result = operation(entry.tokens);
    if (result) operations.push(result);
    else blockers.push({ code: 'DB_MINI_SQL_NOT_EXPAND_ONLY', statementIndex });
  });
  return {
    ok: blockers.length === 0,
    statements: parsed.map(entry => entry.raw),
    operations: blockers.length ? [] : operations,
    blockers
  };
}

/** Validate local pending source inventory before reading or applying any migration. */
export function validateMiniDbInventory(files) {
  if (!Array.isArray(files) || files.length > MAX_MIGRATIONS) fail('DB_MINI_INVENTORY_INVALID');
  const paths = new Set();
  const versions = new Set();
  const names = new Set();
  let bytes = 0;
  let previousVersion = '';
  return files.map(file => {
    const match = typeof file?.path === 'string' ? MIGRATION_PATH.exec(file.path) : null;
    if (
      !match ||
      match[0] !== file.path ||
      paths.has(file.path) ||
      versions.has(match[1]) ||
      names.has(match[2])
    )
      fail('DB_MINI_INVENTORY_INVALID');
    if (previousVersion && match[1] <= previousVersion) fail('DB_MINI_INVENTORY_INVALID');
    const analysis = analyseMiniDbSql(file.sql);
    if (!analysis.ok) fail(analysis.blockers[0].code, analysis.blockers[0].statementIndex);
    bytes += Buffer.byteLength(file.sql, 'utf8');
    if (bytes > BATCH_BYTES) fail('DB_MINI_SOURCE_TOO_LARGE');
    const sourceDigest = digest(file.sql);
    if (
      file.sourceDigest !== undefined &&
      (!DIGEST.test(file.sourceDigest) || file.sourceDigest !== sourceDigest)
    )
      fail('DB_MINI_SOURCE_MISMATCH');
    if (
      (file.version !== undefined && file.version !== match[1]) ||
      (file.name !== undefined && file.name !== match[2])
    )
      fail('DB_MINI_INVENTORY_INVALID');
    paths.add(file.path);
    versions.add(match[1]);
    names.add(match[2]);
    previousVersion = match[1];
    return { path: file.path, version: match[1], name: match[2], sourceDigest, sql: file.sql };
  });
}

/**
 * Official CLI statement bytes are the execution input. This only checks they
 * represent the exact reviewed source, in the same statement order, within
 * the closed grammar. It never substitutes this lexer's chunks for that tuple.
 */
export function assertMiniDbTupleSource(migration) {
  if (
    !migration ||
    typeof migration.sql !== 'string' ||
    typeof migration.sourceDigest !== 'string' ||
    !DIGEST.test(migration.sourceDigest) ||
    digest(migration.sql) !== migration.sourceDigest
  )
    fail('DB_MINI_SOURCE_MISMATCH');
  const analysis = analyseMiniDbSql(migration.sql);
  if (!analysis.ok) fail(analysis.blockers[0].code, analysis.blockers[0].statementIndex);
  if (
    !Array.isArray(migration.statements) ||
    !migration.statements.length ||
    migration.statements.length > MAX_STATEMENTS
  )
    fail('DB_MINI_TUPLE_SOURCE_MISMATCH');
  const source = lex(migration.sql);
  const vendor = [];
  let bytes = 0;
  migration.statements.forEach((statement, index) => {
    if (typeof statement !== 'string') fail('DB_MINI_TUPLE_SOURCE_MISMATCH', index);
    bytes += Buffer.byteLength(statement, 'utf8');
    if (bytes > SOURCE_BYTES) fail('DB_MINI_SOURCE_TOO_LARGE', index);
    const candidate = analyseMiniDbSql(statement);
    if (!candidate.ok) fail('DB_MINI_TUPLE_SOURCE_MISMATCH', index);
    vendor.push(...lex(statement));
    if (vendor.length > MAX_STATEMENTS) fail('DB_MINI_TUPLE_SOURCE_MISMATCH', index);
  });
  if (
    JSON.stringify(source.map(entry => entry.tokens)) !==
    JSON.stringify(vendor.map(entry => entry.tokens))
  )
    fail('DB_MINI_TUPLE_SOURCE_MISMATCH');
  if (migration.path !== undefined) validateMiniDbInventory([migration]);
  return {
    ...analysis,
    canonicalStatements: [...migration.statements],
    sourceDigest: migration.sourceDigest
  };
}

const VETTED_DDL_SOURCE = '0d19428db507118f0e3a9451ba8aa9a7d2d7ded28c79ada5e830fa7d80ba022b';
const VETTED_DDL_DEFINITION = 'e1b6237be816f34af68a11e08af6c12c28d1cb7cb084e054ece8e95d6e22e7d4';
const BTREE_NAMES = new Map([
  ['bool', 'bool_ops'],
  ['int2', 'int2_ops'],
  ['int4', 'int4_ops'],
  ['int8', 'int8_ops'],
  ['text', 'text_ops'],
  ['varchar', 'text_ops'],
  ['uuid', 'uuid_ops'],
  ['jsonb', 'jsonb_ops'],
  ['bytea', 'bytea_ops'],
  ['date', 'date_ops'],
  ['float4', 'float4_ops'],
  ['float8', 'float8_ops'],
  ['numeric', 'numeric_ops'],
  ['timestamp', 'timestamp_ops'],
  ['timestamptz', 'timestamptz_ops'],
  ['time', 'time_ops'],
  ['timetz', 'timetz_ops']
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const same = (before, after) => canonical(before) === canonical(after);
const keyOf = entry => JSON.stringify([entry.kind, entry.schema, entry.name]);

function catalogOf(snapshot) {
  if (!Array.isArray(snapshot?.catalog)) fail('DB_MINI_CATALOG_UNSUPPORTED');
  const rows = new Map();
  for (const entry of snapshot.catalog) {
    if (
      !entry ||
      typeof entry.kind !== 'string' ||
      typeof entry.schema !== 'string' ||
      typeof entry.name !== 'string' ||
      entry.definition === undefined ||
      rows.has(keyOf(entry))
    )
      fail('DB_MINI_CATALOG_UNSUPPORTED');
    rows.set(keyOf(entry), entry);
  }
  return rows;
}

function migrationOperations(migrations) {
  if (!Array.isArray(migrations) || migrations.length > MAX_MIGRATIONS)
    fail('DB_MINI_INVENTORY_INVALID');
  const operations = [];
  for (const migration of migrations) {
    if (migration?.sql !== undefined) {
      if (migration.statements === undefined) {
        // Raw Git drafts are admission-only. Execution plans still require the
        // exact official tuple produced and checked by the vendor rehearsal.
        validateMiniDbInventory([migration]);
        operations.push(...analyseMiniDbSql(migration.sql).operations);
      } else operations.push(...assertMiniDbTupleSource(migration).operations);
      continue;
    }
    if (
      !Array.isArray(migration?.statements) ||
      !migration.statements.length ||
      migration.statements.length > MAX_STATEMENTS
    )
      fail('DB_MINI_TUPLE_SOURCE_MISMATCH');
    let count = 0;
    for (const statement of migration.statements) {
      const analysis = analyseMiniDbSql(statement);
      count += analysis.statements.length;
      if (!analysis.ok || count > MAX_STATEMENTS) fail('DB_MINI_TUPLE_SOURCE_MISMATCH');
      operations.push(...analysis.operations);
    }
  }
  return operations;
}

function admittedEventTriggers(snapshot) {
  if (!Array.isArray(snapshot.eventTriggers)) fail('DB_MINI_EVENT_TRIGGER_UNSUPPORTED');
  for (const trigger of snapshot.eventTriggers) {
    if (!trigger || typeof trigger !== 'object') fail('DB_MINI_EVENT_TRIGGER_UNSUPPORTED');
    if (trigger.enabled === 'D') continue;
    if (!['ddl_command_start', 'ddl_command_end'].includes(trigger.event)) continue;
    if (
      trigger.tags !== null &&
      (!Array.isArray(trigger.tags) || trigger.tags.some(tag => typeof tag !== 'string'))
    )
      fail('DB_MINI_EVENT_TRIGGER_UNSUPPORTED');
    if (
      trigger.tags !== null &&
      !trigger.tags.some(tag => ['ALTER TABLE', 'CREATE INDEX'].includes(tag.toUpperCase().trim()))
    )
      continue;
    if (
      !['O', 'R', 'A'].includes(trigger.enabled) ||
      trigger.event !== 'ddl_command_end' ||
      trigger.function !== 'extensions.pgrst_ddl_watch()' ||
      trigger.language !== 'plpgsql' ||
      !['postgres', 'supabase_admin'].includes(trigger.functionOwner) ||
      !['postgres', 'supabase_admin'].includes(trigger.owner) ||
      typeof trigger.securityDefiner !== 'boolean' ||
      typeof trigger.source !== 'string' ||
      typeof trigger.functionDefinition !== 'string' ||
      digest(trigger.source) !== VETTED_DDL_SOURCE ||
      digest(trigger.functionDefinition) !== VETTED_DDL_DEFINITION
    )
      fail('DB_MINI_EVENT_TRIGGER_UNSUPPORTED');
  }
}

function columnType(operation) {
  const basic = {
    bool: 'boolean',
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision'
  };
  const mods = operation.typeModifiers;
  let value = basic[operation.baseType] ?? operation.baseType;
  if (operation.baseType === 'varchar')
    value = `character varying${mods.length ? `(${mods[0]})` : ''}`;
  else if (operation.baseType === 'numeric')
    value = `numeric${mods.length ? `(${mods[0]},${mods[1] ?? 0})` : ''}`;
  else if (['time', 'timetz', 'timestamp', 'timestamptz'].includes(operation.baseType)) {
    const withZone = ['timetz', 'timestamptz'].includes(operation.baseType);
    const clock = ['time', 'timetz'].includes(operation.baseType) ? 'time' : 'timestamp';
    value = `${clock}${mods.length ? `(${mods[0]})` : ''} ${withZone ? 'with' : 'without'} time zone`;
  }
  return value + (operation.array ? '[]' : '');
}

function scalarType(type) {
  const fixed = new Map([
    ['boolean', 'bool'],
    ['smallint', 'int2'],
    ['integer', 'int4'],
    ['bigint', 'int8'],
    ['text', 'text'],
    ['uuid', 'uuid'],
    ['jsonb', 'jsonb'],
    ['bytea', 'bytea'],
    ['date', 'date'],
    ['real', 'float4'],
    ['double precision', 'float8']
  ]);
  if (fixed.has(type)) return fixed.get(type);
  if (typeof type !== 'string') return null;
  if (/^character varying(?:\([0-9]+\))?$/u.test(type)) return 'varchar';
  if (/^numeric(?:\([0-9]+,-?[0-9]+\))?$/u.test(type)) return 'numeric';
  if (/^timestamp(?:\([0-6]\))? without time zone$/u.test(type)) return 'timestamp';
  if (/^timestamp(?:\([0-6]\))? with time zone$/u.test(type)) return 'timestamptz';
  if (/^time(?:\([0-6]\))? without time zone$/u.test(type)) return 'time';
  if (/^time(?:\([0-6]\))? with time zone$/u.test(type)) return 'timetz';
  return null;
}

function safeIndexColumn(column) {
  const definition = column?.definition;
  const base = scalarType(definition?.type);
  const wanted = base ? BTREE_NAMES.get(base) : null;
  if (
    !base ||
    !wanted ||
    definition.typeSchema !== 'pg_catalog' ||
    definition.typeKind !== 'b' ||
    !(
      (definition.collation === null && definition.collationSchema === null) ||
      (['default', 'C', 'POSIX'].includes(definition.collation) &&
        definition.collationSchema === 'pg_catalog')
    ) ||
    !Array.isArray(definition.btreeOpclasses) ||
    definition.btreeOpclasses.length !== 1 ||
    definition.btreeOpclasses[0]?.schema !== 'pg_catalog' ||
    definition.btreeOpclasses[0]?.name !== wanted
  )
    fail('DB_MINI_INDEX_COLUMN_UNSUPPORTED');
}

function simulatedColumn(operation) {
  const collatable = ['text', 'varchar'].includes(operation.baseType);
  const opclass = BTREE_NAMES.get(operation.baseType);
  return {
    kind: 'column',
    schema: 'public',
    name: `${operation.table}.${operation.column}`,
    definition: {
      type: columnType(operation),
      typeSchema: 'pg_catalog',
      typeKind: 'b',
      collation: collatable ? 'default' : null,
      collationSchema: collatable ? 'pg_catalog' : null,
      btreeOpclasses: operation.array || !opclass ? [] : [{ schema: 'pg_catalog', name: opclass }]
    }
  };
}

/** Catalog preconditions are checked independently of the textual SQL allowlist. */
export function assertMiniDbSafety(before, migrations) {
  const operations = migrationOperations(migrations);
  if (!operations.length) return { operations };
  const catalog = catalogOf(before);
  admittedEventTriggers(before);
  const usedIndexes = new Set();
  for (const operation of operations) {
    const relation = catalog.get(JSON.stringify(['relation', 'public', operation.table]));
    const shape = relation?.definition;
    if (
      !shape ||
      shape.kind !== 'r' ||
      shape.accessMethod !== 'heap' ||
      shape.partition !== null ||
      !Array.isArray(shape.parents) ||
      shape.parents.length ||
      !Array.isArray(shape.children) ||
      shape.children.length
    )
      fail('DB_MINI_TABLE_UNSUPPORTED');
    if (operation.kind === 'add-column') {
      const column = simulatedColumn(operation);
      if (catalog.has(keyOf(column))) fail('DB_MINI_OBJECT_ALREADY_EXISTS');
      catalog.set(keyOf(column), column);
    } else {
      if (
        usedIndexes.has(operation.name) ||
        [...catalog.values()].some(
          entry =>
            entry.schema === 'public' &&
            entry.name === operation.name &&
            ['relation', 'index', 'sequence'].includes(entry.kind)
        )
      )
        fail('DB_MINI_OBJECT_ALREADY_EXISTS');
      for (const name of operation.columns)
        safeIndexColumn(
          catalog.get(JSON.stringify(['column', 'public', `${operation.table}.${name}`]))
        );
      usedIndexes.add(operation.name);
    }
  }
  return { operations };
}

/** No existing catalog, privilege, policy, hook or platform metadata may change. */
export function assertMiniDbTransition(before, after, migrations) {
  const { operations } = assertMiniDbSafety(before, migrations);
  for (const field of ['pgMajor', 'extensions', 'ledgerDigest', 'eventTriggers']) {
    if (!same(before[field], after[field])) fail('DB_MINI_PLATFORM_CHANGED');
  }
  if (!operations.length) {
    if (!same(before.history, after.history)) fail('DB_MINI_HISTORY_CHANGED');
    if (!same(before.catalog, after.catalog)) fail('DB_MINI_EXISTING_OBJECT_CHANGED');
    return { ok: true, operations };
  }
  const oldCatalog = catalogOf(before);
  const nextCatalog = catalogOf(after);
  for (const [key, value] of oldCatalog)
    if (!nextCatalog.has(key) || !same(value, nextCatalog.get(key)))
      fail('DB_MINI_EXISTING_OBJECT_CHANGED');
  const expected = new Map(
    operations.map(operation => [
      JSON.stringify([
        operation.kind === 'add-column' ? 'column' : 'index',
        'public',
        operation.kind === 'add-column' ? `${operation.table}.${operation.column}` : operation.name
      ]),
      operation
    ])
  );
  const maxPositions = new Map();
  for (const row of oldCatalog.values())
    if (
      row.kind === 'column' &&
      row.schema === 'public' &&
      Number.isInteger(row.definition.position)
    ) {
      const table = row.name.slice(0, row.name.lastIndexOf('.'));
      maxPositions.set(table, Math.max(maxPositions.get(table) ?? 0, row.definition.position));
    }
  for (const key of nextCatalog.keys())
    if (!oldCatalog.has(key) && !expected.has(key)) fail('DB_MINI_UNPLANNED_OBJECT');
  for (const [key, operation] of expected) {
    const row = nextCatalog.get(key);
    if (!row) fail('DB_MINI_EXPECTED_OBJECT_MISSING');
    const definition = row.definition;
    if (operation.kind === 'add-column') {
      const collatable = ['text', 'varchar'].includes(operation.baseType);
      if (
        definition.type !== columnType(operation) ||
        definition.typeSchema !== 'pg_catalog' ||
        definition.typeKind !== 'b' ||
        definition.nullable !== true ||
        definition.default !== null ||
        definition.identity !== '' ||
        definition.generated !== '' ||
        definition.acl !== null ||
        !Number.isInteger(definition.position) ||
        definition.position <= (maxPositions.get(operation.table) ?? 0) ||
        (collatable
          ? definition.collation !== 'default' || definition.collationSchema !== 'pg_catalog'
          : definition.collation !== null || definition.collationSchema !== null)
      )
        fail('DB_MINI_COLUMN_POSTCONDITION_FAILED');
      maxPositions.set(operation.table, definition.position);
    } else {
      const parsed = analyseMiniDbSql(definition.sql);
      if (
        definition.valid !== true ||
        definition.ready !== true ||
        definition.live !== true ||
        !parsed.ok ||
        parsed.operations.length !== 1 ||
        !same(parsed.operations[0], operation)
      )
        fail('DB_MINI_INDEX_POSTCONDITION_FAILED');
    }
  }
  return { ok: true, operations };
}
