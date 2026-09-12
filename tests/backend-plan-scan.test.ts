import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clientBreakingStatements,
  incompatibleMigrations,
  stripComments
} from '../scripts/lib/release/migration-compat.mjs';
import {
  buildBackendPlan,
  describePlan,
  functionsNeedingDeploy
} from '../scripts/lib/release/backend-scan.mjs';

const FUNCTIONS = [
  'catalog-sync',
  'delete-account',
  'drive-connect',
  'drive-ops',
  'issue-agent-token'
];

describe('what a migration does to a client that has not updated', () => {
  it('accepts an additive migration', () => {
    expect(
      clientBreakingStatements(
        'alter table public.profiles add column nickname text;\ncreate index on public.profiles (nickname);'
      )
    ).toEqual([]);
  });

  it('does not call a redefinition a removal', () => {
    // The dominant shape in this repository: drop the old signature, create the
    // new one, in one migration. Fourteen migrations do it, and a check that
    // flagged all fourteen would simply be switched off.
    expect(
      clientBreakingStatements(
        'drop function if exists public.list_team_tasks(uuid, integer);\n' +
          'create or replace function public.list_team_tasks(uuid, integer, text) returns setof record as $$ select 1 $$ language sql;'
      )
    ).toEqual([]);
  });

  it('does not mistake a publication change for a dropped table', () => {
    // `alter publication ... drop table` removes a table from realtime and
    // leaves the table exactly where it is. Two real migrations here do that.
    expect(
      clientBreakingStatements('alter publication supabase_realtime drop table public.team_tasks;')
    ).toEqual([]);
  });

  it('reports the removals that break a running client', () => {
    expect(
      clientBreakingStatements('drop function public.search_materials(uuid);').map(
        problem => problem.reason
      )
    ).toEqual(['drops function public.search_materials without recreating it']);

    expect(
      clientBreakingStatements('alter table public.team_agents drop column note;').map(
        problem => problem.reason
      )
    ).toEqual(['drops column note from public.team_agents']);

    expect(
      clientBreakingStatements('alter table public.team_task_labels rename to team_labels;').map(
        problem => problem.reason
      )
    ).toEqual(['renames table public.team_task_labels to team_labels']);

    expect(
      clientBreakingStatements(
        'alter table public.events alter column occurred_at set not null;'
      ).map(problem => problem.reason)
    ).toEqual(["makes column occurred_at mandatory, which the released client's inserts may omit"]);
  });

  it('ignores a drop that is only mentioned in a comment', () => {
    expect(stripComments('-- drop table public.profiles;\nselect 1;')).not.toContain('drop table');
    expect(clientBreakingStatements('-- drop table public.profiles;\nselect 1;')).toEqual([]);
  });

  it('stays quiet on the migrations this repository actually ships', () => {
    // A calibration test, not a snapshot: of 112 tracked migrations only a
    // handful are genuinely destructive, and if this check ever starts flagging
    // a large fraction of them it has become noise and needs narrowing, whatever
    // its unit tests say.
    const directory = path.resolve('supabase/migrations');
    const migrations = readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => ({ id: name, sql: readFileSync(path.join(directory, name), 'utf8') }));
    const flagged = new Set(incompatibleMigrations(migrations).map(problem => problem.id));
    expect(migrations.length).toBeGreaterThan(100);
    expect(flagged.size).toBeLessThan(migrations.length * 0.1);
  });
});

describe('deriving the backend plan', () => {
  it('redeploys every function when a shared module changed', () => {
    // The omission a person makes: the diff is one file, and it silently changes
    // the behaviour of ten deployed programs.
    expect(
      functionsNeedingDeploy({
        changedPaths: ['supabase/functions/_shared/cors.ts'],
        functions: FUNCTIONS
      })
    ).toEqual([...FUNCTIONS].sort());
  });

  it('redeploys only the functions whose own files changed', () => {
    expect(
      functionsNeedingDeploy({
        changedPaths: [
          'supabase/functions/catalog-sync/engine.ts',
          'apps/web/src/App.tsx',
          'supabase/migrations/20260912150000_x.sql'
        ],
        functions: FUNCTIONS
      })
    ).toEqual(['catalog-sync']);
  });

  it('ignores a directory that is not a deployed function', () => {
    expect(
      functionsNeedingDeploy({
        changedPaths: ['supabase/functions/retired-thing/index.ts'],
        functions: FUNCTIONS
      })
    ).toEqual([]);
  });

  it('orders schema before the functions that may depend on it', () => {
    const { plan, blockers } = buildBackendPlan({
      targetId: 'production',
      migrations: [{ id: '20260912150000', digest: 'a'.repeat(64), sql: 'select 1;' }],
      functions: [{ name: 'catalog-sync', digest: 'b'.repeat(64) }]
    });
    expect(blockers).toEqual([]);
    expect(plan?.changes.map(change => `${change.kind}:${change.id}`)).toEqual([
      'migration:20260912150000',
      'function:catalog-sync'
    ]);
    expect(plan?.changes[1].dependencies).toEqual(['20260912150000']);
    expect(plan?.changes.every(change => change.position === 'before-web')).toBe(true);
  });

  it('refuses to plan a migration the released client cannot survive', () => {
    const { plan, blockers } = buildBackendPlan({
      targetId: 'production',
      migrations: [
        {
          id: '20260912150000',
          digest: 'a'.repeat(64),
          sql: 'alter table public.p drop column note;'
        }
      ],
      functions: []
    });
    expect(plan).toBeNull();
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('drops column note from public.p');
    expect(blockers[0]).toContain('split it into a compatible change now');
  });

  it('says plainly when a release changes nothing on the server', () => {
    const { plan } = buildBackendPlan({ targetId: 'production', migrations: [], functions: [] });
    expect(describePlan(plan)).toBe('no server changes');
    expect(plan?.changes).toEqual([]);
  });
});
