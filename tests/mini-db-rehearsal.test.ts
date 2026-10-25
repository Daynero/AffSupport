import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  loadMiniDbMigrationSources,
  rehearseMiniDbPlan,
  validateMiniDbRehearsalDraft
} from '../scripts/lib/mini-db-rehearsal.mjs';
import { dbValueDigest, validateMiniDbSnapshot } from '../scripts/lib/mini-db-transaction.mjs';
import { assertMiniDbSafety, assertMiniDbTransition } from '../scripts/lib/mini-db-policy.mjs';

const binding = { digest: 'b'.repeat(64) };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function source(version: string, name: string, sql: string) {
  return {
    version,
    name,
    sql,
    path: `supabase/migrations/${version}_${name}.sql`,
    sourceDigest: digest(sql)
  };
}
const baseline = source('20261024000000', 'widgets', 'CREATE TABLE public.widgets (id bigint);');
const pending = source(
  '20261025000000',
  'optional_note',
  'ALTER TABLE public.widgets ADD COLUMN note text;'
);

function snapshot(applied = false, full = false) {
  const rows = [
    baseline,
    ...(applied ? [pending] : []),
    ...(full
      ? [
          source(
            '99991231235959',
            'mini_interop_probe',
            'CREATE TABLE public.soty_mini_db_interop_probe (id bigint);'
          )
        ]
      : [])
  ];
  return validateMiniDbSnapshot({
    pgMajor: 17,
    eventTriggers: [],
    extensions: [{ name: 'plpgsql', version: '1.0' }],
    history: rows.map(({ version, name, sql }) => ({ version, name, statements: [sql] })),
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
          position: 1,
          type: 'bigint',
          typeSchema: 'pg_catalog',
          typeKind: 'b',
          nullable: true,
          default: null,
          identity: '',
          generated: '',
          collation: null,
          collationSchema: null,
          acl: null,
          btreeOpclasses: [{ schema: 'pg_catalog', name: 'int8_ops' }]
        }
      },
      ...(applied
        ? [
            {
              kind: 'column',
              schema: 'public',
              name: 'widgets.note',
              definition: {
                position: 2,
                type: 'text',
                typeSchema: 'pg_catalog',
                typeKind: 'b',
                nullable: true,
                default: null,
                identity: '',
                generated: '',
                collation: 'default',
                collationSchema: 'pg_catalog',
                acl: null,
                btreeOpclasses: [{ schema: 'pg_catalog', name: 'text_ops' }]
              }
            }
          ]
        : []),
      ...(full
        ? [
            {
              kind: 'relation',
              schema: 'public',
              name: 'soty_mini_db_interop_probe',
              definition: {
                kind: 'r',
                accessMethod: 'heap',
                partition: null,
                parents: [],
                children: []
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
  });
}
function draft(empty = false) {
  const sources = empty ? [baseline] : [baseline, pending];
  return {
    kind: 'mini-db-draft',
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    agentSha: 'c'.repeat(40),
    bindingDigest: binding.digest,
    targetId: 'fixture',
    projectRef: 'fixture',
    inventory: sources.map(({ version, name, path, sourceDigest }) => ({
      version,
      name,
      path,
      sourceDigest
    })),
    migrations: empty ? [] : [pending],
    before: snapshot()
  };
}
function fixture(empty = false) {
  let full = false;
  const events: string[] = [];
  const runtime = {
    urls: { mini: 'postgresql://postgres:owned-ephemeral@127.0.0.1:5432/soty_mini_db_fixture' },
    cliVersion: '2.117.0',
    imageId: `sha256:${'d'.repeat(64)}`,
    push: vi.fn(async (database: string, files: { version: string }[]) => {
      events.push(`push:${database}`);
      if (database === 'mini') full = files.at(-1)?.version === '99991231235959';
    }),
    snapshot: vi.fn(async (database: string) => {
      events.push(`snapshot:${database}`);
      return snapshot(database !== 'baseline', database === 'mini' && full);
    }),
    clone: vi.fn(async () => {
      events.push('clone');
    }),
    close: vi.fn(async () => {
      events.push('close');
    })
  };
  const deps = {
    assertSafety: vi.fn(),
    assertTransition: vi.fn(),
    loadSources: vi.fn(async () => (empty ? [baseline] : [baseline, pending])),
    createRuntime: vi.fn(async () => runtime),
    applyPlan: vi.fn(async () => {
      events.push('apply:mini');
    }),
    persistArtifact: vi.fn(async () => {
      events.push('persist');
      return '/private/fixture.json';
    })
  };
  return { runtime, deps, events, options: { cwd: '/fixture', plan: draft(empty), binding, deps } };
}

describe('mini DB rehearsal source and baseline gates', () => {
  it('ignores tracked ROLLBACK.md while requiring exact complete SQL inventory', async () => {
    const plan = draft();
    const readGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${plan.sourceSha}\n`;
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-files')
        return [baseline, pending].map(item => `H ${item.path}`).join('\n');
      if (args[0] === 'ls-tree')
        return `${[baseline, pending]
          .map(item => `100644 blob ${'e'.repeat(40)}\t${item.path}`)
          .join('\n')}\n100644 blob ${'f'.repeat(40)}\tsupabase/migrations/ROLLBACK.md`;
      return args[1].endsWith(baseline.path) ? baseline.sql : pending.sql;
    });
    await expect(loadMiniDbMigrationSources({ cwd: '/fixture', plan, readGit })).resolves.toEqual([
      baseline,
      pending
    ]);
    expect(
      readGit.mock.calls.some(([args]) => args[0] === 'show' && args[1].endsWith('ROLLBACK.md'))
    ).toBe(false);
    await expect(
      loadMiniDbMigrationSources({
        cwd: '/fixture',
        plan: { ...plan, inventory: plan.inventory.slice(1) },
        readGit
      })
    ).rejects.toThrow('INVENTORY_INCOMPLETE');
  });
  it('blocks dirty Git and hidden source flags before reading SQL', async () => {
    const plan = draft();
    for (const hidden of [false, true]) {
      const readGit = vi.fn(async (args: string[]) =>
        args[0] === 'rev-parse'
          ? plan.sourceSha
          : args[0] === 'status'
            ? hidden
              ? ''
              : ' M changed.sql'
            : `S ${pending.path}`
      );
      await expect(loadMiniDbMigrationSources({ cwd: '/fixture', plan, readGit })).rejects.toThrow(
        hidden ? 'HIDDEN_SOURCE_FLAGS' : 'CLEAN_SOURCE_REQUIRED'
      );
      expect(readGit.mock.calls.some(([args]) => args[0] === 'show')).toBe(false);
    }
  });
  it('refuses a gap or changed target catalog before creating a container', async () => {
    const f = fixture();
    f.options.plan.before.history = [];
    await expect(
      rehearseMiniDbPlan({ ...f.options, targetBeforeSnapshot: snapshot() })
    ).rejects.toThrow('TARGET_CHANGED');
    expect(f.deps.createRuntime).not.toHaveBeenCalled();
    const plan = draft();
    const target = snapshot();
    target.history = [{ version: pending.version, name: pending.name, statements: [pending.sql] }];
    plan.before = validateMiniDbSnapshot(target);
    expect(() =>
      validateMiniDbRehearsalDraft(plan, binding, plan.before, [baseline, pending])
    ).toThrow('HISTORY_NOT_PREFIX');
  });
  it('blocks non-additive SQL and pending source edits', () => {
    const plan = draft();
    const destructive = source(pending.version, pending.name, 'DROP TABLE public.widgets;');
    expect(() =>
      validateMiniDbRehearsalDraft({ ...plan, migrations: [destructive] }, binding, plan.before, [
        baseline,
        destructive
      ])
    ).toThrow('SQL_NOT_ADDITIVE');
    expect(() =>
      validateMiniDbRehearsalDraft(
        { ...plan, migrations: [{ ...pending, sql: `${pending.sql} ` }] },
        binding,
        plan.before,
        [baseline, pending]
      )
    ).toThrow('PENDING_MISMATCH');
  });
});

describe('mini DB vendor interoperability orchestration', () => {
  it('runs real semantic policy from raw draft through canonical tuple transition', async () => {
    const f = fixture();
    const result = await rehearseMiniDbPlan({
      ...f.options,
      deps: {
        ...f.deps,
        assertSafety: assertMiniDbSafety,
        assertTransition: assertMiniDbTransition
      }
    });
    expect(result.evidence.checks.miniVendor).toBe('matched');
    expect(result.plan.migrations[0].statements).toEqual([pending.sql]);
  });
  it('proves exact baseline, official tuple, mini apply, and next full CLI before publishing evidence', async () => {
    const f = fixture();
    const result = await rehearseMiniDbPlan(f.options);
    expect(f.events).toEqual([
      'push:baseline',
      'snapshot:baseline',
      'clone',
      'push:vendor',
      'snapshot:vendor',
      'apply:mini',
      'snapshot:mini',
      'push:mini',
      'snapshot:mini',
      'persist',
      'close'
    ]);
    expect(result.plan.migrations[0].statements).toEqual([pending.sql]);
    const { planDigest, ...content } = result.plan;
    expect(planDigest).toBe(dbValueDigest(content));
    expect(result.plan.bindingDigest).toBe(binding.digest);
    const local = f.deps.applyPlan.mock.calls[0] as unknown as [
      { plan: { bindingDigest: string }; connectionString: string }
    ];
    expect(local[0].plan.bindingDigest).not.toBe(binding.digest);
    expect(local[0].connectionString).toMatch(/127\.0\.0\.1/);
    expect(result.evidence.checks).toEqual({
      baseline: 'matched',
      miniVendor: 'matched',
      nextFullCli: 'verified',
      productSmoke: 'not_performed'
    });
    expect(JSON.stringify(result.evidence)).not.toContain('owned-ephemeral');
  });
  it('requires actual catalog equality even when baseline history matches', async () => {
    const f = fixture();
    f.runtime.snapshot.mockImplementation(async () =>
      validateMiniDbSnapshot({ ...snapshot(), catalog: [] })
    );
    await expect(rehearseMiniDbPlan(f.options)).rejects.toThrow('BASELINE_MISMATCH');
    expect(f.runtime.clone).not.toHaveBeenCalled();
    expect(f.deps.applyPlan).not.toHaveBeenCalled();
    expect(f.deps.persistArtifact).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it('blocks vendor source/tuple disagreement and always cleans up', async () => {
    const f = fixture();
    f.runtime.snapshot.mockImplementation(async database =>
      database === 'baseline'
        ? snapshot()
        : validateMiniDbSnapshot({
            ...snapshot(true),
            history: [
              snapshot().history[0],
              {
                version: pending.version,
                name: pending.name,
                statements: ['DROP TABLE public.widgets']
              }
            ]
          })
    );
    await expect(rehearseMiniDbPlan(f.options)).rejects.toThrow();
    expect(f.deps.applyPlan).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it('refuses mismatch after the mini executor and failed full interoperability', async () => {
    for (const phase of ['mini', 'full']) {
      const f = fixture();
      let miniReads = 0;
      f.runtime.snapshot.mockImplementation(async database => {
        if (database === 'baseline') return snapshot();
        if (database === 'vendor') return snapshot(true);
        miniReads += 1;
        return phase === 'mini' || miniReads === 2 ? snapshot() : snapshot(true);
      });
      await expect(rehearseMiniDbPlan(f.options)).rejects.toThrow(
        phase === 'mini' ? 'MINI_VENDOR_MISMATCH' : 'NEXT_FULL_CLI_FAILED'
      );
      expect(f.deps.persistArtifact).not.toHaveBeenCalled();
      expect(f.runtime.close).toHaveBeenCalledOnce();
    }
  });
  it('replays baseline only for a later web hotfix and never invokes empty apply', async () => {
    const f = fixture(true);
    const result = await rehearseMiniDbPlan(f.options);
    expect(f.events).toEqual(['push:baseline', 'snapshot:baseline', 'persist', 'close']);
    expect(f.runtime.clone).not.toHaveBeenCalled();
    expect(f.deps.applyPlan).not.toHaveBeenCalled();
    expect(result.plan.after).toEqual(result.plan.before);
    expect(result.evidence.checks.nextFullCli).toBe('not_needed');
  });
  it('does not return success if artifact durability or owned cleanup fails', async () => {
    for (const failAt of ['artifact', 'cleanup']) {
      const f = fixture();
      if (failAt === 'artifact')
        f.deps.persistArtifact.mockRejectedValue(new Error('ARTIFACT_FAILED'));
      else f.runtime.close.mockRejectedValue(new Error('CLEANUP_UNCONFIRMED'));
      await expect(rehearseMiniDbPlan(f.options)).rejects.toThrow(
        failAt === 'artifact' ? 'ARTIFACT_FAILED' : 'CLEANUP_UNCONFIRMED'
      );
      expect(f.runtime.close).toHaveBeenCalledOnce();
    }
  });
});
