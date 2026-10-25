import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  applyMiniDbPlan,
  dbValueDigest,
  readMiniDbSnapshot,
  reconcileMiniDbPlan,
  validateMiniDbPlan,
  validateMiniDbSnapshot,
  validateMiniDbTarget
} from '../scripts/lib/mini-db-transaction.mjs';

const binding = {
  kind: 'local-test',
  bindingId: 'local-mini-db',
  supabaseProject: 'local-mini-db',
  digest: 'b'.repeat(64)
};
const connectionString = 'postgresql://postgres:fixture-secret@127.0.0.1:5432/soty_mini_db_fixture';
const session = { pid: 411, backendStart: '2026-10-25T12:00:00.000Z' };
const migration = {
  version: '20261025120000',
  name: 'optional_note',
  sourceDigest: 'c'.repeat(64),
  statements: ['ALTER TABLE public.widgets ADD COLUMN note text']
};

function rawSnapshot(applied = false) {
  return {
    pgMajor: 17,
    eventTriggers: [],
    extensions: [{ name: 'plpgsql', version: '1.0' }],
    history: applied
      ? [migration].map(({ version, name, statements }) => ({ version, name, statements }))
      : [],
    catalog: [
      {
        kind: 'relation',
        schema: 'public',
        name: 'widgets',
        definition: { kind: 'r', accessMethod: 'heap', partition: null, parents: [], children: [] }
      },
      {
        kind: 'column',
        schema: 'public',
        name: 'widgets.id',
        definition: {
          type: 'bigint',
          typeSchema: 'pg_catalog',
          typeKind: 'b',
          collation: null,
          collationSchema: null,
          btreeOpclasses: [{ schema: 'pg_catalog', name: 'int8_ops' }],
          nullable: false,
          default: null,
          identity: '',
          generated: '',
          position: 1,
          acl: null
        }
      },
      ...(applied
        ? [
            {
              kind: 'column',
              schema: 'public',
              name: 'widgets.note',
              definition: {
                type: 'text',
                typeSchema: 'pg_catalog',
                typeKind: 'b',
                collation: 'default',
                collationSchema: 'pg_catalog',
                btreeOpclasses: [{ schema: 'pg_catalog', name: 'text_ops' }],
                nullable: true,
                default: null,
                identity: '',
                generated: '',
                position: 2,
                acl: null
              }
            }
          ]
        : [])
    ],
    ledger: {
      kind: 'r',
      accessMethod: 'heap',
      uniqueVersion: true,
      triggers: 0,
      policies: 0,
      rules: 0,
      constraints: [
        {
          name: 'schema_migrations_pkey',
          kind: 'p',
          definition: 'PRIMARY KEY (version)',
          versionOnly: true,
          deferrable: false,
          deferred: false,
          validated: true
        }
      ],
      indexes: [
        {
          name: 'schema_migrations_pkey',
          unique: true,
          valid: true,
          ready: true,
          live: true,
          immediate: true,
          versionOnly: true,
          expression: false,
          predicate: false,
          method: 'btree',
          opclassSchema: 'pg_catalog',
          opclass: 'text_ops'
        }
      ],
      rls: false,
      columns: [
        {
          name: 'version',
          type: 'text',
          notNull: true,
          default: null,
          identity: '',
          generated: ''
        },
        { name: 'name', type: 'text', notNull: false, default: null, identity: '', generated: '' },
        {
          name: 'statements',
          type: 'text[]',
          notNull: false,
          default: null,
          identity: '',
          generated: ''
        }
      ]
    }
  };
}

function planFixture() {
  const before = validateMiniDbSnapshot(rawSnapshot());
  const after = validateMiniDbSnapshot(rawSnapshot(true));
  const content = {
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    agentSha: 'd'.repeat(40),
    bindingDigest: binding.digest,
    migrations: [structuredClone(migration)],
    before: {
      pgMajor: 17,
      historyDigest: before.historyDigest,
      catalogDigest: before.catalogDigest
    },
    after: { pgMajor: 17, historyDigest: after.historyDigest, catalogDigest: after.catalogDigest }
  };
  return { ...content, planDigest: dbValueDigest(content) };
}

function rehashPlan(plan: ReturnType<typeof planFixture>) {
  const content = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest'));
  return dbValueDigest(content);
}

function driver(
  options: {
    lostCommit?: boolean;
    failStatement?: boolean;
    ownSessionAlive?: boolean;
    afterDrift?: boolean;
    tick?: () => void;
    serverTimeouts?: { transactionTimeoutMs?: unknown; idleTimeoutMs?: unknown };
  } = {}
) {
  const calls: { owner: number; text: string; values: unknown[]; timeout?: number }[] = [];
  let applied = false;
  let created = 0;
  const configs: Record<string, unknown>[] = [];
  const factory = (config: Record<string, unknown> = {}) => {
    configs.push(config);
    const owner = created++;
    let pending = false;
    return {
      connect: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      query: vi.fn(
        async (input: string | { text: string; values?: unknown[]; query_timeout?: number }) => {
          const text = typeof input === 'string' ? input : input.text;
          const values = typeof input === 'string' ? [] : (input.values ?? []);
          calls.push({
            owner,
            text,
            values,
            timeout: typeof input === 'string' ? undefined : input.query_timeout
          });
          options.tick?.();
          if (text.includes('mini-db:identity')) {
            const startup = String(config.options ?? '');
            const transactionTimeoutMs = /-c transaction_timeout=([0-9]+)/.exec(startup)?.[1];
            const idleTimeoutMs = /-c idle_in_transaction_session_timeout=([0-9]+)/.exec(
              startup
            )?.[1];
            return {
              rows: [{ ...session, transactionTimeoutMs, idleTimeoutMs, ...options.serverTimeouts }]
            };
          }
          if (text.includes('mini-db:session-absence'))
            return { rows: [{ absent: !options.ownSessionAlive }] };
          if (text.includes('mini-db:snapshot')) {
            const snapshot = rawSnapshot(applied || pending);
            if (options.afterDrift && pending)
              snapshot.catalog.push({
                ...structuredClone(snapshot.catalog[1]),
                name: 'unapproved'
              });
            return { rows: [snapshot] };
          }
          if (text === migration.statements[0]) {
            if (options.failStatement) throw new Error('private fixture-secret query failure');
            pending = true;
          }
          if (text === 'ROLLBACK') pending = false;
          if (text === 'COMMIT' && owner === 0) {
            applied = pending;
            if (options.lostCommit) throw new Error('socket lost fixture-secret');
          }
          return { rows: [] };
        }
      )
    };
  };
  return { factory, calls, configs };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mini DB immutable plan and supported target', () => {
  it('hashes canonical JSON and rejects tuple mutations after approval', () => {
    expect(dbValueDigest({ b: 2, a: 1 })).toBe(dbValueDigest({ a: 1, b: 2 }));
    const plan = planFixture();
    expect(validateMiniDbPlan(plan, binding)).toEqual(plan);
    plan.migrations[0].statements.push('SELECT 1');
    expect(() => validateMiniDbPlan(plan, binding)).toThrow('DB_PLAN_DIGEST_MISMATCH');
  });

  it('preserves a vendor tuple element containing several admitted SQL statements', () => {
    const plan = planFixture();
    const grouped = `${migration.statements[0]};\nCREATE INDEX widgets_note_idx ON public.widgets(note);`;
    plan.migrations[0].statements = [grouped];
    plan.planDigest = rehashPlan(plan);
    expect(validateMiniDbPlan(plan, binding).migrations[0].statements).toEqual([grouped]);
  });

  it('bounds total parsed SQL statements across vendor tuple elements', () => {
    const plan = planFixture();
    plan.migrations[0].statements = [
      Array(65).fill(`${migration.statements[0]};`).join('\n'),
      Array(64).fill(`${migration.statements[0]};`).join('\n')
    ];
    plan.planDigest = rehashPlan(plan);
    expect(() => validateMiniDbPlan(plan, binding)).toThrow('DB_PLAN_SQL_UNSAFE');
  });

  it('requires ordered unique versions even when someone recomputes the plan digest', () => {
    const plan = planFixture();
    plan.migrations.push(structuredClone(migration));
    plan.planDigest = rehashPlan(plan);
    expect(() => validateMiniDbPlan(plan, binding)).toThrow('DB_PLAN_INVALID');
  });

  it('refuses transaction control in a forged tuple even with a freshly recomputed plan hash', async () => {
    const plan = planFixture();
    plan.migrations[0].statements = ['COMMIT; BEGIN;'];
    plan.planDigest = rehashPlan(plan);
    const { factory, calls } = driver();
    await expect(
      applyMiniDbPlan({
        plan,
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {}
      })
    ).rejects.toMatchObject({ code: 'DB_PLAN_SQL_UNSAFE' });
    expect(calls).toEqual([]);
  });

  it('blocks PostgreSQL before 17, which cannot enforce the absolute server transaction deadline', () => {
    const plan = planFixture();
    plan.before.pgMajor = 16;
    plan.planDigest = rehashPlan(plan);
    expect(() => validateMiniDbPlan(plan, binding)).toThrow('DB_PG_MAJOR_UNSUPPORTED');
  });

  it('allows an unchanged backend plan for later web hotfixes without opening a write transaction', async () => {
    const plan = planFixture();
    plan.migrations = [];
    plan.after = { ...plan.before };
    plan.planDigest = rehashPlan(plan);
    expect(validateMiniDbPlan(plan, binding)).toEqual(plan);
    const { factory, calls } = driver();
    await expect(
      applyMiniDbPlan({
        plan,
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {}
      })
    ).rejects.toMatchObject({ code: 'DB_NO_PENDING_MIGRATIONS' });
    expect(calls).toEqual([]);
  });

  it('accepts pinned direct/session endpoints with verified TLS, never transaction/analytics roles', () => {
    const project = 'abcdefghijklmnopqrst';
    const production = { ...binding, kind: 'production', supabaseProject: project };
    expect(
      validateMiniDbTarget(
        production,
        `postgresql://postgres:secret@db.${project}.supabase.co/postgres`
      ).ssl
    ).toEqual({ rejectUnauthorized: true });
    expect(
      validateMiniDbTarget(
        production,
        `postgresql://postgres.${project}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`
      ).port
    ).toBe(5432);
    for (const url of [
      `postgresql://postgres.${project}:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
      `postgresql://analytics:secret@db.${project}.supabase.co/postgres`,
      `postgresql://postgres:secret@db.${project}.supabase.co/postgres?sslmode=require`,
      'postgresql://postgres:secret@127.0.0.1/postgres',
      `postgresql://postgres:secret@db.${project}.supabase.co/postgres?options=-c%20search_path=public`
    ])
      expect(() => validateMiniDbTarget(production, url)).toThrow('DB_TARGET_INVALID');
  });

  it('only allows explicit owned local database names and rejects a remote local-test URL', () => {
    expect(validateMiniDbTarget(binding, connectionString).database).toBe('soty_mini_db_fixture');
    expect(() =>
      validateMiniDbTarget(binding, connectionString.replace('127.0.0.1', 'database.internal'))
    ).toThrow('DB_TARGET_INVALID');
    expect(() =>
      validateMiniDbTarget(binding, connectionString.replace('soty_mini_db_fixture', 'postgres'))
    ).toThrow('DB_TARGET_INVALID');
  });
});

describe('mini DB supported vendor ledger and semantic snapshot', () => {
  it('includes extension versions and grants in the catalog identity, without depending on row order', () => {
    const before = rawSnapshot();
    const same = structuredClone(before);
    same.catalog.reverse();
    expect(validateMiniDbSnapshot(same).catalogDigest).toBe(
      validateMiniDbSnapshot(before).catalogDigest
    );
    same.extensions[0].version = '2.0';
    expect(validateMiniDbSnapshot(same).catalogDigest).not.toBe(
      validateMiniDbSnapshot(before).catalogDigest
    );
  });

  it.each([
    'trigger',
    'policy',
    'required-column',
    'missing-unique',
    'default',
    'custom-table-am',
    'rewrite-rule',
    'check',
    'expression-index'
  ])('blocks unsupported ledger %s', kind => {
    const value = rawSnapshot();
    if (kind === 'trigger') value.ledger.triggers = 1;
    if (kind === 'policy') value.ledger.policies = 1;
    if (kind === 'custom-table-am') value.ledger.accessMethod = 'custom_side_effect_am';
    if (kind === 'rewrite-rule') value.ledger.rules = 1;
    if (kind === 'check')
      value.ledger.constraints.push({
        ...value.ledger.constraints[0],
        name: 'side_effect_check',
        kind: 'c'
      });
    if (kind === 'expression-index') value.ledger.indexes[0].expression = true;
    if (kind === 'missing-unique') value.ledger.uniqueVersion = false;
    if (kind === 'default') value.ledger.columns[0].default = 'unsafe' as never;
    if (kind === 'required-column')
      value.ledger.columns.push({
        name: 'tenant',
        type: 'text',
        notNull: true,
        default: null,
        identity: '',
        generated: ''
      });
    expect(() => validateMiniDbSnapshot(value)).toThrow('DB_LEDGER_UNSUPPORTED');
  });

  it('redacts all driver errors', async () => {
    await expect(
      readMiniDbSnapshot({
        query: async () => {
          throw new Error(connectionString);
        }
      })
    ).rejects.toThrow('DB_SNAPSHOT_UNAVAILABLE');
  });

  it('binds event-trigger body, ownership and enabled state into the before/after catalog identity', () => {
    const initial = rawSnapshot();
    const original = validateMiniDbSnapshot(initial);
    const hook = {
      name: 'ddl_hook',
      event: 'ddl_command_end',
      tags: ['ALTER TABLE'],
      enabled: 'O',
      function: 'private.ddl_hook()',
      functionDefinition: 'CREATE FUNCTION private.ddl_hook() RETURNS event_trigger ...',
      source: 'BEGIN NULL; END',
      language: 'plpgsql',
      securityDefiner: true,
      owner: 'postgres',
      functionOwner: 'postgres'
    };
    const withHook = { ...initial, eventTriggers: [hook] };
    expect(validateMiniDbSnapshot(withHook).catalogDigest).not.toBe(original.catalogDigest);
    const enabledDigest = validateMiniDbSnapshot(withHook).catalogDigest;
    expect(
      validateMiniDbSnapshot({ ...withHook, eventTriggers: [{ ...hook, enabled: 'D' }] })
        .catalogDigest
    ).not.toBe(enabledDigest);
    expect(
      validateMiniDbSnapshot({
        ...withHook,
        eventTriggers: [{ ...hook, source: 'BEGIN RAISE EXCEPTION; END' }]
      }).catalogDigest
    ).not.toBe(enabledDigest);
  });
});

describe('mini DB single transaction and observed outcomes', () => {
  it.each([
    { transactionTimeoutMs: '0' },
    { idleTimeoutMs: '0' },
    { transactionTimeoutMs: null },
    { transactionTimeoutMs: undefined },
    { idleTimeoutMs: '30001' },
    { transactionTimeoutMs: '30s' }
  ])(
    'refuses ignored or unproven server timeout settings before durable preparation: %j',
    async serverTimeouts => {
      const { factory, calls } = driver({ serverTimeouts });
      const journal = vi.fn(async () => {});
      await expect(
        applyMiniDbPlan({
          plan: planFixture(),
          binding,
          connectionString,
          clientFactory: factory,
          journal
        })
      ).rejects.toMatchObject({ code: 'DB_SERVER_DEADLINE_UNPROVEN' });
      expect(journal).not.toHaveBeenCalled();
      expect(
        calls.some(call => call.text.startsWith('BEGIN') || call.text.startsWith('INSERT'))
      ).toBe(false);
      expect(calls.some(call => call.text === migration.statements[0])).toBe(false);
    }
  );

  it('restricts shortened transaction budgets to owned local tests and keeps production defaults fixed', async () => {
    for (const budget of [0, -1, 1.5, 30001, Infinity]) {
      const { factory, calls } = driver();
      await expect(
        applyMiniDbPlan({
          plan: planFixture(),
          binding,
          connectionString,
          clientFactory: factory,
          journal: async () => {},
          localTestBudgetMs: budget
        })
      ).rejects.toMatchObject({ code: 'DB_BUDGET_INVALID' });
      expect(calls).toEqual([]);
    }
    const { factory, calls } = driver();
    const production = { ...binding, kind: 'production', supabaseProject: 'abcdefghijklmnopqrst' };
    await expect(
      applyMiniDbPlan({
        plan: planFixture(),
        binding: production,
        connectionString:
          'postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co/postgres',
        clientFactory: factory,
        journal: async () => {},
        localTestBudgetMs: 2000
      })
    ).rejects.toMatchObject({ code: 'DB_BUDGET_OVERRIDE_FORBIDDEN' });
    expect(calls).toEqual([]);
    const local = driver();
    expect(
      (
        await applyMiniDbPlan({
          plan: planFixture(),
          binding,
          connectionString,
          clientFactory: local.factory,
          journal: async () => {},
          localTestBudgetMs: 2000
        })
      ).dbOutcome
    ).toBe('committed');
    expect(
      local.calls
        .filter(call => call.text.includes("set_config('statement_timeout'"))
        .every(call => Number(call.values[0]) <= 2000)
    ).toBe(true);
    expect(local.configs[0].options).toContain('transaction_timeout=2000');
    expect(local.configs[0].options).toContain('idle_in_transaction_session_timeout=2000');
  });

  it('awaits prepared durability, executes exact SQL and parameterized tuple, and independently verifies commit', async () => {
    const { factory, calls } = driver();
    const journal = vi.fn(async receipt => {
      expect(receipt.session).toEqual(session);
      expect(calls.some(c => c.text.startsWith('BEGIN'))).toBe(false);
    });
    const result = await applyMiniDbPlan({
      plan: planFixture(),
      binding,
      connectionString,
      clientFactory: factory,
      journal
    });
    expect(result.dbOutcome).toBe('committed');
    expect(journal).toHaveBeenCalledOnce();
    const writer = calls.filter(c => c.owner === 0);
    expect(writer.filter(c => c.text.startsWith('BEGIN'))).toHaveLength(1);
    const statement = writer.findIndex(c => c.text === migration.statements[0]);
    const insert = writer.findIndex(c => c.text.startsWith('INSERT INTO'));
    const commit = writer.findIndex(c => c.text === 'COMMIT');
    expect(statement).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(statement);
    expect(commit).toBeGreaterThan(insert);
    expect(writer[insert].values).toEqual([
      migration.version,
      migration.name,
      migration.statements
    ]);
    expect(calls.some(c => c.owner === 1 && c.text.includes('mini-db:snapshot'))).toBe(true);
    expect(
      writer
        .filter(c => c.text.includes("set_config('statement_timeout'"))
        .every(c => Number(c.values[1]) <= 2000)
    ).toBe(true);
  });

  it('adopts lost COMMIT only after an independent exact after observation, without replaying SQL', async () => {
    const { factory, calls } = driver({ lostCommit: true });
    const result = await applyMiniDbPlan({
      plan: planFixture(),
      binding,
      connectionString,
      clientFactory: factory,
      journal: async () => {}
    });
    expect(result.dbOutcome).toBe('adopted');
    expect(calls.filter(c => c.text === migration.statements[0])).toHaveLength(1);
  });

  it('proves aborted only from exact before plus absence of the original PID/start identity', async () => {
    const { factory } = driver({ failStatement: true });
    await expect(
      applyMiniDbPlan({
        plan: planFixture(),
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {}
      })
    ).rejects.toMatchObject({ code: 'DB_APPLY_FAILED', dbOutcome: 'aborted', session });
    const live = driver({ ownSessionAlive: true });
    expect(
      (
        await reconcileMiniDbPlan({
          plan: planFixture(),
          binding,
          connectionString,
          session,
          clientFactory: live.factory
        })
      ).dbOutcome
    ).toBe('unknown');
  });

  it('rolls back a catalog mismatch before COMMIT, and never leaks driver URL/SQL in errors', async () => {
    const { factory, calls } = driver({ afterDrift: true });
    await expect(
      applyMiniDbPlan({
        plan: planFixture(),
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {}
      })
    ).rejects.toMatchObject({ code: 'DB_AFTER_MISMATCH', dbOutcome: 'aborted' });
    expect(calls.some(c => c.owner === 0 && c.text === 'COMMIT')).toBe(false);
    expect(calls.some(c => c.text === 'ROLLBACK')).toBe(true);
  });

  it('does not begin a transaction when durable preparation fails', async () => {
    const { factory, calls } = driver();
    await expect(
      applyMiniDbPlan({
        plan: planFixture(),
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {
          throw new Error(connectionString);
        }
      })
    ).rejects.toMatchObject({ code: 'DB_APPLY_FAILED', dbOutcome: 'aborted' });
    expect(calls.some(c => c.owner === 0 && c.text.startsWith('BEGIN'))).toBe(false);
  });

  it('shrinks server timeouts and refuses application SQL once the absolute transaction reserve is spent', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const { factory, calls } = driver({
      tick: () => {
        elapsed += 4000;
      }
    });
    await expect(
      applyMiniDbPlan({
        plan: planFixture(),
        binding,
        connectionString,
        clientFactory: factory,
        journal: async () => {}
      })
    ).rejects.toMatchObject({ code: 'DB_DEADLINE_EXCEEDED', dbOutcome: 'aborted' });
    const budgets = calls
      .filter(c => c.owner === 0 && c.text.includes("set_config('statement_timeout'"))
      .map(c => Number(c.values[0]));
    expect(budgets.length).toBeGreaterThan(1);
    expect(budgets.every((budget, index) => index === 0 || budget < budgets[index - 1])).toBe(true);
    expect(calls.some(c => c.owner === 0 && c.text === 'COMMIT')).toBe(false);
  });
});
