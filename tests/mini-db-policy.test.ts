import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyseMiniDbSql,
  assertMiniDbSafety,
  assertMiniDbTransition,
  assertMiniDbTupleSource,
  validateMiniDbInventory
} from '../scripts/lib/mini-db-policy.mjs';

const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const file = (sql: string, version = '20261025120000', name = 'add_note') => ({
  path: `supabase/migrations/${version}_${name}.sql`,
  sql,
  sourceDigest: sha(sql)
});

function ordinaryRelation() {
  return {
    kind: 'relation',
    schema: 'public',
    name: 'profiles',
    definition: {
      kind: 'r',
      accessMethod: 'heap',
      partition: null,
      parents: [],
      children: [],
      owner: 'postgres',
      acl: 'unchanged',
      rls: true
    }
  };
}

function catalogColumn(name: string, type = 'integer', position = 1) {
  const text = type === 'text';
  return {
    kind: 'column',
    schema: 'public',
    name: `profiles.${name}`,
    definition: {
      type,
      typeSchema: 'pg_catalog',
      typeKind: 'b',
      nullable: name !== 'id',
      default: null,
      identity: '',
      generated: '',
      acl: null,
      position,
      collation: text ? 'default' : null,
      collationSchema: text ? 'pg_catalog' : null,
      btreeOpclasses: [{ schema: 'pg_catalog', name: text ? 'text_ops' : 'int4_ops' }]
    }
  };
}

function snapshot() {
  return {
    pgMajor: 17,
    extensions: [{ name: 'plpgsql', version: '1.0' }],
    ledgerDigest: 'a'.repeat(64),
    history: [],
    eventTriggers: [] as Record<string, unknown>[],
    catalog: [ordinaryRelation(), catalogColumn('id')] as Record<string, any>[]
  };
}

const migration = (sql: string, version = '20261025120000', name = 'add_note') => ({
  ...file(sql, version, name),
  statements: [sql]
});

describe('DB mini catalog admission', () => {
  const add = migration('alter table public.profiles add column note text;');
  const index = migration('create index profiles_id_idx on public.profiles (id);');

  it('admits ordinary owned-table additions and builtin default btree indexes', () => {
    expect(assertMiniDbSafety(snapshot(), [add]).operations).toHaveLength(1);
    expect(assertMiniDbSafety(snapshot(), [index]).operations).toHaveLength(1);
  });

  it('admits source-bound raw Git drafts before official tuples exist, without inventing tuples', () => {
    const raw = file('ALTER TABLE public.profiles ADD COLUMN note text;');
    expect(assertMiniDbSafety(snapshot(), [raw]).operations).toHaveLength(1);
    expect(raw).not.toHaveProperty('statements');
    expect(() =>
      assertMiniDbSafety(snapshot(), [{ ...raw, sql: `${raw.sql}\n-- changed` }])
    ).toThrow('SOURCE_MISMATCH');
    expect(() => assertMiniDbTupleSource(raw)).toThrow('TUPLE_SOURCE_MISMATCH');
  });

  it.each([
    { kind: 'f' },
    { kind: 'v' },
    { kind: 'p' },
    { accessMethod: 'custom_side_effect_am' },
    { accessMethod: undefined },
    { partition: 'FOR VALUES IN (1)' },
    { parents: ['private.base'] },
    { children: ['private.child'] },
    { parents: undefined }
  ])('rejects a target whose table semantics are not admitted %j', patch => {
    const before = snapshot();
    Object.assign(before.catalog[0].definition, patch);
    expect(() => assertMiniDbSafety(before, [add])).toThrow('TABLE_UNSUPPORTED');
  });

  it('refuses missing tables, existing columns and index namespace collisions', () => {
    const missing = snapshot();
    missing.catalog.shift();
    expect(() => assertMiniDbSafety(missing, [add])).toThrow('TABLE_UNSUPPORTED');
    expect(() =>
      assertMiniDbSafety(snapshot(), [migration('alter table public.profiles add column id text;')])
    ).toThrow('OBJECT_ALREADY_EXISTS');
    expect(() =>
      assertMiniDbSafety(snapshot(), [migration('create index profiles on public.profiles (id);')])
    ).toThrow('OBJECT_ALREADY_EXISTS');
  });

  it.each([
    { typeSchema: 'public' },
    { typeKind: 'd' },
    { type: 'public.custom' },
    { type: 'integer[]' },
    { collation: 'custom', collationSchema: 'public' },
    { collation: 'C', collationSchema: 'public' },
    { btreeOpclasses: [] },
    { btreeOpclasses: [{ schema: 'public', name: 'int4_ops' }] },
    { btreeOpclasses: [{ schema: 'pg_catalog', name: 'custom_ops' }] },
    {
      btreeOpclasses: [
        { schema: 'pg_catalog', name: 'int4_ops' },
        { schema: 'public', name: 'other_ops' }
      ]
    }
  ])('rejects unknown/custom index comparison semantics %j', patch => {
    const before = snapshot();
    Object.assign(before.catalog[1].definition, patch);
    expect(() => assertMiniDbSafety(before, [index])).toThrow('INDEX_COLUMN_UNSUPPORTED');
  });

  it('simulates new columns sequentially so a later admitted index can use them', () => {
    const operations = [
      add,
      migration(
        'create index profiles_note_idx on public.profiles (note);',
        '20261025130000',
        'index_note'
      )
    ];
    expect(assertMiniDbSafety(snapshot(), operations).operations).toHaveLength(2);
    expect(() => assertMiniDbSafety(snapshot(), [...operations].reverse())).toThrow(
      'INDEX_COLUMN_UNSUPPORTED'
    );
  });

  it('does not admit even the known hook identity when its exact bytes differ', () => {
    const before = snapshot();
    before.eventTriggers.push({
      name: 'pgrst_ddl_watch',
      event: 'ddl_command_end',
      tags: null,
      enabled: 'O',
      function: 'extensions.pgrst_ddl_watch()',
      functionDefinition: 'changed definition',
      source: 'begin null; end;',
      language: 'plpgsql',
      securityDefiner: false,
      owner: 'postgres',
      functionOwner: 'postgres'
    });
    expect(() => assertMiniDbSafety(before, [add])).toThrow('EVENT_TRIGGER_UNSUPPORTED');
  });

  it.each(['ddl_command_start', 'ddl_command_end'])(
    'rejects an enabled relevant unknown %s hook',
    event => {
      const before = snapshot();
      before.eventTriggers.push({
        name: 'unknown',
        event,
        tags: ['ALTER TABLE'],
        enabled: 'O',
        function: 'private.audit()'
      });
      expect(() => assertMiniDbSafety(before, [add])).toThrow('EVENT_TRIGGER_UNSUPPORTED');
    }
  );

  it('ignores disabled and genuinely irrelevant hooks for admitted DDL tags', () => {
    const before = snapshot();
    before.eventTriggers.push(
      { name: 'disabled', event: 'ddl_command_end', tags: null, enabled: 'D' },
      { name: 'drop_only', event: 'sql_drop', tags: null, enabled: 'O' },
      { name: 'other_tags', event: 'ddl_command_end', tags: ['CREATE FUNCTION'], enabled: 'O' }
    );
    expect(assertMiniDbSafety(before, [add]).operations).toHaveLength(1);
  });
});

describe('exact additive catalog transition', () => {
  const sql = 'alter table public.profiles add column note text;';
  const changes = [migration(sql)];
  function upgraded() {
    const after = snapshot();
    after.catalog.push(catalogColumn('note', 'text', 2));
    return after;
  }

  it('requires precisely the planned nullable column and preserves all earlier metadata', () => {
    expect(assertMiniDbTransition(snapshot(), upgraded(), changes).ok).toBe(true);
  });

  it.each([
    { nullable: false },
    { default: 'now()' },
    { identity: 'a' },
    { generated: 's' },
    { acl: 'new grant' },
    { type: 'integer' },
    { typeSchema: 'public' },
    { typeKind: 'd' },
    { position: 1 },
    { collation: 'C' },
    { collationSchema: 'public' }
  ])('refuses a new column with unexpected semantics %j', patch => {
    const after = upgraded();
    Object.assign(after.catalog[2].definition, patch);
    expect(() => assertMiniDbTransition(snapshot(), after, changes)).toThrow(
      'COLUMN_POSTCONDITION'
    );
  });

  it('rejects changed old privileges/columns, missing additions and unplanned objects', () => {
    const altered = upgraded();
    altered.catalog[0].definition.acl = 'changed';
    expect(() => assertMiniDbTransition(snapshot(), altered, changes)).toThrow(
      'EXISTING_OBJECT_CHANGED'
    );
    expect(() => assertMiniDbTransition(snapshot(), snapshot(), changes)).toThrow(
      'EXPECTED_OBJECT_MISSING'
    );
    const unplanned = upgraded();
    unplanned.catalog.push({
      kind: 'routine',
      schema: 'public',
      name: 'unexpected()',
      definition: { sql: 'arbitrary' }
    });
    expect(() => assertMiniDbTransition(snapshot(), unplanned, changes)).toThrow(
      'UNPLANNED_OBJECT'
    );
    const removed = upgraded();
    removed.catalog.splice(1, 1);
    expect(() => assertMiniDbTransition(snapshot(), removed, changes)).toThrow(
      'EXISTING_OBJECT_CHANGED'
    );
  });

  it.each(['pgMajor', 'extensions', 'ledgerDigest', 'eventTriggers'])(
    'preserves platform/ledger metadata %s',
    field => {
      const after: Record<string, any> = upgraded();
      after[field] =
        field === 'pgMajor' ? 18 : field === 'ledgerDigest' ? 'b'.repeat(64) : [{ changed: true }];
      expect(() => assertMiniDbTransition(snapshot(), after, changes)).toThrow('PLATFORM_CHANGED');
    }
  );

  it('verifies new index identity and readiness and rejects unique/changed expressions', () => {
    const change = migration('create index profiles_id_idx on public.profiles (id);');
    const after = snapshot();
    after.catalog.push({
      kind: 'index',
      schema: 'public',
      name: 'profiles_id_idx',
      definition: {
        sql: 'CREATE INDEX profiles_id_idx ON public.profiles USING btree (id)',
        valid: true,
        ready: true,
        live: true
      }
    });
    expect(assertMiniDbTransition(snapshot(), after, [change]).ok).toBe(true);
    for (const field of ['valid', 'ready', 'live']) {
      const bad = structuredClone(after);
      bad.catalog[2].definition[field] = false;
      expect(() => assertMiniDbTransition(snapshot(), bad, [change])).toThrow(
        'INDEX_POSTCONDITION'
      );
    }
    const bad = structuredClone(after);
    bad.catalog[2].definition.sql =
      'CREATE UNIQUE INDEX profiles_id_idx ON public.profiles USING btree (id)';
    expect(() => assertMiniDbTransition(snapshot(), bad, [change])).toThrow('INDEX_POSTCONDITION');
  });

  it('checks added positions in operation order rather than catalog row order', () => {
    const first = migration('alter table public.profiles add column zeta text;');
    const second = migration(
      'alter table public.profiles add column alpha integer;',
      '20261025130000',
      'add_alpha'
    );
    const after = snapshot();
    after.catalog.push(catalogColumn('alpha', 'integer', 3), catalogColumn('zeta', 'text', 2));
    expect(assertMiniDbTransition(snapshot(), after, [first, second]).ok).toBe(true);
  });

  it('needs no hook enrollment for an empty plan but still refuses any state change', () => {
    const before = snapshot();
    before.eventTriggers.push({
      name: 'unknown',
      event: 'ddl_command_end',
      tags: null,
      enabled: 'O'
    });
    expect(assertMiniDbSafety(before, []).operations).toEqual([]);
    expect(assertMiniDbTransition(before, structuredClone(before), []).ok).toBe(true);
    const changed = structuredClone(before);
    changed.catalog.push(catalogColumn('extra', 'text', 2));
    expect(() => assertMiniDbTransition(before, changed, [])).toThrow('EXISTING_OBJECT_CHANGED');
  });
});

describe('closed additive DB mini grammar', () => {
  it('accepts nullable metadata-only columns and plain nonunique indexes', () => {
    const result = analyseMiniDbSql(`
      ALTER TABLE public.profiles ADD COLUMN note text;
      create index profiles_note_idx on public.profiles using btree (note, id);
    `);
    expect(result.ok).toBe(true);
    expect(result.operations).toEqual([
      {
        kind: 'add-column',
        schema: 'public',
        table: 'profiles',
        column: 'note',
        type: 'text',
        baseType: 'text',
        typeModifiers: [],
        array: false
      },
      {
        kind: 'create-index',
        schema: 'public',
        table: 'profiles',
        name: 'profiles_note_idx',
        columns: ['note', 'id']
      }
    ]);
  });

  it.each([
    'text',
    'boolean',
    'bool',
    'smallint',
    'int2',
    'integer',
    'int',
    'int4',
    'bigint',
    'int8',
    'uuid',
    'jsonb',
    'bytea',
    'date',
    'real',
    'float4',
    'float8',
    'double precision',
    'varchar',
    'varchar(128)',
    'character varying(64)',
    'numeric',
    'numeric(12,2)',
    'decimal(20)',
    'timestamp',
    'timestamp(3)',
    'timestamp(6) with time zone',
    'timestamp without time zone',
    'timestamptz',
    'time(0)',
    'time with time zone',
    'time without time zone',
    'timetz',
    'text[]',
    'numeric(8,2)[]'
  ])('accepts only the admitted builtin type %s', type => {
    expect(analyseMiniDbSql(`alter table public.profiles add column note ${type};`).ok).toBe(true);
  });

  it('does not split semicolons or interpret misleading SQL inside nested comments', () => {
    const result = analyseMiniDbSql(`
      /* outer ; DROP TABLE public.profiles; /* nested 'x;'; */ ignored */
      ALTER /* ; */ TABLE public.profiles ADD COLUMN note text; -- 'drop';
      create index profiles_note_idx on public.profiles (note);
      -- trailing comment ; 'quoted' -- harmless
    `);
    expect(result.ok).toBe(true);
    expect(result.statements).toHaveLength(2);
    expect(result.operations.map(entry => entry.kind)).toEqual(['add-column', 'create-index']);
  });

  it.each([
    'begin; alter table public.profiles add column note text; commit;',
    'select 1;',
    'update public.profiles set note = null;',
    'delete from public.profiles;',
    'truncate public.profiles;',
    'alter table public.profiles drop column note;',
    'alter table public.profiles rename column note to old_note;',
    'alter table public.profiles add column note text default null;',
    'alter table public.profiles add column note text not null;',
    'alter table public.profiles add column note text unique;',
    'alter table public.profiles add column note text check (note is null);',
    'alter table public.profiles add column account_id uuid references public.accounts (id);',
    'alter table public.profiles add column note text collate pg_catalog.default;',
    'alter table public.profiles add column n integer generated always as identity;',
    'alter table public.profiles add column note public.custom_type;',
    'alter table public.profiles add column if not exists note text;',
    'alter table public.profiles add note text;',
    'alter table only public.profiles add column note text;',
    'alter table private.profiles add column note text;',
    'alter table auth.users add column note text;',
    'alter table public.profiles add column note text, add column note2 text;',
    'create table public.new_table (id uuid);',
    'create unique index profiles_idx on public.profiles (id);',
    'create index concurrently profiles_idx on public.profiles (id);',
    'create index if not exists profiles_idx on public.profiles (id);',
    'create index public.profiles_idx on public.profiles (id);',
    'create index profiles_idx on public.profiles using gin (id);',
    'create index profiles_idx on public.profiles (lower(id));',
    'create index profiles_idx on public.profiles (id) where id is not null;',
    'create index profiles_idx on public.profiles (id) include (note);',
    'create index profiles_idx on public.profiles (id) tablespace pg_default;',
    'create index profiles_idx on public.profiles (id desc);',
    'create index profiles_idx on public.profiles (id, id);',
    'create index profiles_idx on public.profiles ();',
    'alter table public.profiles disable row level security;',
    'grant select on public.profiles to anon;',
    'set statement_timeout = 0;',
    'alter table public.profiles add column note varchar(0);',
    'alter table public.profiles add column note numeric(0);',
    'alter table public.profiles add column note numeric(5,6);',
    'alter table public.profiles add column note timestamp(7);',
    'alter table public.profiles add column note text[2];',
    'alter table public.profiles add column note text[][];',
    'alter table public.profiles add column note text; drop table public.profiles;',
    'alter table public.profiles add column note text; alter table auth.users add column note text;',
    'alter table public.profiles add column note text;-- misleading comment\rdrop table public.profiles;'
  ])('rejects unsupported or potentially client-breaking SQL: %s', sql => {
    const result = analyseMiniDbSql(sql);
    expect(result.ok).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it.each([
    'alter table public."profiles" add column note text;',
    "alter table public.profiles add column note text default 'x; drop table x;';",
    "do $$ begin execute 'drop table public.profiles'; end $$;",
    '\\i secret.sql',
    'alter\u00a0table public.profiles add column note text;',
    'alter table public.\u212a add column note text;',
    'alter table public.profiles add column \u017f text;',
    'alter table public.profiles add column note te\u0000xt;',
    '/* \u0000 */ alter table public.profiles add column note text;',
    'alter table public.profiles add column note text;/* unterminated',
    'alter table public.profiles add column note text;;',
    '-- pg-delta: transaction=false\nalter table public.profiles add column note text;',
    '/* +goose NO TRANSACTION */alter table public.profiles add column note text;',
    '-- transaction = false\nalter table public.profiles add column note text;',
    '-- migrate:up\nalter table public.profiles add column note text;'
  ])('rejects lexer escapes/directives and ambiguous input: %s', sql => {
    expect(analyseMiniDbSql(sql).ok).toBe(false);
  });

  it.each(['', ' -- only comments', '/* only comment */'])('rejects an empty migration %j', sql => {
    expect(analyseMiniDbSql(sql).ok).toBe(false);
  });
});

describe('reviewed source and official vendor tuple correspondence', () => {
  const sql =
    '/* reviewed */ ALTER TABLE public.profiles ADD COLUMN note text;\ncreate index profiles_note_idx on public.profiles (note);';
  const statements = [
    'alter table public.profiles add column note text',
    'create index profiles_note_idx on public.profiles (note)'
  ];

  it('accepts vendor trimming/comments/case without replacing the official statement bytes', () => {
    const result = assertMiniDbTupleSource({ ...file(sql), statements });
    expect(result.ok).toBe(true);
    expect(result.canonicalStatements).toEqual(statements);
    expect(result.sourceDigest).toBe(sha(sql));
  });

  it('preserves official grouped statement bytes while checking the same complete ordered SQL', () => {
    const grouped = [`${statements[0]};\n${statements[1]};`];
    const result = assertMiniDbTupleSource({ ...file(sql), statements: grouped });
    expect(result.canonicalStatements).toEqual(grouped);
    expect(result.operations).toHaveLength(2);
    expect(() => assertMiniDbSafety(snapshot(), [{ statements: grouped }])).not.toThrow();
  });

  it('accepts mixed vendor grouping without joining token boundaries between elements', () => {
    const source = `${sql}\nALTER TABLE public.profiles ADD COLUMN visible bool;`;
    const grouped = [
      `${statements[0]}; ${statements[1]};`,
      'ALTER TABLE public.profiles ADD COLUMN visible bool;'
    ];
    expect(
      assertMiniDbTupleSource({ ...file(source), statements: grouped }).operations
    ).toHaveLength(3);
    expect(() =>
      assertMiniDbTupleSource({
        ...file(sql),
        statements: ['ALTER TABLE public.profiles ADD', 'COLUMN note text;', statements[1]]
      })
    ).toThrow('TUPLE_SOURCE_MISMATCH');
  });

  it('binds the raw source, including a comment-only change', () => {
    expect(() =>
      assertMiniDbTupleSource({ ...file(sql), sql: `-- edit\n${sql}`, statements })
    ).toThrow('SOURCE_MISMATCH');
    expect(() => assertMiniDbTupleSource({ sql, statements })).toThrow('SOURCE_MISMATCH');
  });

  it.each([
    [statements[1], statements[0]],
    [statements[0]],
    [...statements, statements[0]],
    ['alter table public.profiles add column other text', statements[1]],
    [`${statements[0]}; ${statements[1]};`, statements[1]],
    [
      'alter table public.profiles add column note text; drop table public.profiles;',
      statements[1]
    ],
    ['/* comments only */', statements[1]],
    [statements[0], 'create unique index profiles_note_idx on public.profiles (note)']
  ])('rejects changed/reordered/duplicated/injected vendor statements %j', (...candidate) => {
    expect(() => assertMiniDbTupleSource({ ...file(sql), statements: candidate })).toThrow(
      'TUPLE_SOURCE_MISMATCH'
    );
  });
});

describe('bounded pending migration inventory', () => {
  const sql = 'alter table public.profiles add column note text;';
  it('records the exact ordered path/version/name/source digest', () => {
    expect(validateMiniDbInventory([file(sql)])).toEqual([
      { ...file(sql), version: '20261025120000', name: 'add_note' }
    ]);
  });
  it.each([
    '../20261025120000_add_note.sql',
    '/tmp/20261025120000_add_note.sql',
    'supabase/migrations/1_add_note.sql',
    'supabase/migrations/20261025120000_AddNote.sql',
    'supabase/migrations/20261025120000_add-note.sql',
    'supabase/migrations/nested/20261025120000_add_note.sql',
    'supabase/migrations/20261025120000_add_note.sql\n'
  ])('rejects an unsafe/noncanonical path %j', path => {
    expect(() => validateMiniDbInventory([{ ...file(sql), path }])).toThrow('INVENTORY_INVALID');
  });
  it('rejects duplicate paths, versions and names rather than choosing one', () => {
    expect(() => validateMiniDbInventory([file(sql), file(sql)])).toThrow('INVENTORY_INVALID');
    expect(() =>
      validateMiniDbInventory([file(sql), file(sql, '20261025120000', 'other')])
    ).toThrow('INVENTORY_INVALID');
    expect(() =>
      validateMiniDbInventory([file(sql), file(sql, '20261025130000', 'add_note')])
    ).toThrow('INVENTORY_INVALID');
    expect(() =>
      validateMiniDbInventory([
        file(sql, '20261025130000', 'later'),
        file(sql, '20261025120000', 'earlier')
      ])
    ).toThrow('INVENTORY_INVALID');
  });
  it('refuses inventory/hash/metadata disagreement and unsupported SQL', () => {
    expect(() => validateMiniDbInventory([{ ...file(sql), sourceDigest: 'f'.repeat(64) }])).toThrow(
      'SOURCE_MISMATCH'
    );
    expect(() => validateMiniDbInventory([{ ...file(sql), version: '20261025130000' }])).toThrow(
      'INVENTORY_INVALID'
    );
    expect(() => validateMiniDbInventory([file('drop table public.profiles;')])).toThrow(
      'NOT_EXPAND_ONLY'
    );
  });
  it('caps a pending batch and input size before it can become an unbounded parser workload', () => {
    expect(() => validateMiniDbInventory(Array.from({ length: 33 }, () => file(sql)))).toThrow(
      'INVENTORY_INVALID'
    );
    expect(analyseMiniDbSql(`/*${' '.repeat(2 * 1024 * 1024)}*/${sql}`).ok).toBe(false);
    expect(analyseMiniDbSql(Array.from({ length: 129 }, () => sql).join('\n')).ok).toBe(false);
  });
});
