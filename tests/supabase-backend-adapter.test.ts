import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTemporaryDirectory } from './support/temp-dir.js';
import {
  createSupabaseBackendAdapter,
  lastJsonLine
} from '../scripts/lib/release/adapters/supabase-backend.mjs';

/**
 * The adapter drives a command-line tool, so every test here supplies that tool
 * as a function. Nothing reaches a network, and the shapes it is fed are the
 * ones the real CLI produced when this was written.
 */
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'supabase-backend-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const MIGRATIONS = JSON.stringify({
  migrations: [
    { local: '20260907140000', remote: '20260907140000' },
    { local: '20260912150000', remote: '' }
  ]
});

const FUNCTIONS = JSON.stringify([
  { slug: 'catalog-sync', status: 'ACTIVE', version: 17 },
  { slug: 'preview-warm', status: 'REMOVED', version: 3 }
]);

describe('the Supabase backend adapter', () => {
  it('finds the JSON the CLI prints after its progress lines', () => {
    // The real output opens with "Initialising login role..." and a notice about
    // skipping ROLLBACK.md, then one line of JSON.
    const output = `Initialising login role...\nSkipping migration ROLLBACK.md...\n${MIGRATIONS}\n`;
    expect(lastJsonLine(output).migrations).toHaveLength(2);
    expect(() => lastJsonLine('nothing parsable here')).toThrow('no JSON in CLI output');
  });

  it('reports exactly the migrations the remote is missing', async () => {
    const root = await project({ 'supabase/migrations/20260912150000_x.sql': 'select 1;' });
    try {
      const adapter = createSupabaseBackendAdapter({
        projectRef: 'ref',
        targetId: 'production',
        root,
        accessToken: 'token',
        run: () => MIGRATIONS
      });
      expect(await adapter.pendingMigrations()).toEqual(['20260912150000']);
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it("includes the shared modules in a function's digest", async () => {
    // A function whose own files did not change still changed if `_shared` did.
    // Hashing only its directory would call it unchanged on exactly the day its
    // behaviour was rewritten under it.
    const files = {
      'supabase/functions/catalog-sync/index.ts': 'export const a = 1;',
      'supabase/functions/_shared/cors.ts': 'export const cors = 1;'
    };
    const before = await project(files);
    const after = await project({
      ...files,
      'supabase/functions/_shared/cors.ts': 'export const cors = 2;'
    });
    try {
      const digest = (root: string) =>
        createSupabaseBackendAdapter({
          projectRef: 'ref',
          targetId: 'production',
          root,
          accessToken: 'token',
          run: () => ''
        }).digestOf({ kind: 'function', id: 'catalog-sync' });
      expect(await digest(before)).not.toBe(await digest(after));
    } finally {
      await removeTemporaryDirectory(before);
      await removeTemporaryDirectory(after);
    }
  });

  it('answers the compatibility question from the migration it will actually run', async () => {
    const root = await project({
      'supabase/migrations/20260912150000_safe.sql': 'alter table public.p add column note text;',
      'supabase/migrations/20260912160000_unsafe.sql': 'alter table public.p drop column note;'
    });
    try {
      const adapter = createSupabaseBackendAdapter({
        projectRef: 'ref',
        targetId: 'production',
        root,
        accessToken: 'token',
        run: () => ''
      });
      expect(await adapter.backwardsCompatible({ kind: 'migration', id: '20260912150000' })).toBe(
        true
      );
      expect(await adapter.backwardsCompatible({ kind: 'migration', id: '20260912160000' })).toBe(
        false
      );
      // A function replaces its own implementation and carries no schema the
      // released client depends on.
      expect(await adapter.backwardsCompatible({ kind: 'function', id: 'catalog-sync' })).toBe(
        true
      );
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it('pushes migrations without touching vault secrets, and deploys functions by name', async () => {
    const root = await project({ 'supabase/migrations/20260912150000_x.sql': 'select 1;' });
    const calls: string[][] = [];
    try {
      const adapter = createSupabaseBackendAdapter({
        projectRef: 'ref',
        targetId: 'production',
        root,
        accessToken: 'token',
        run: args => {
          calls.push([...args]);
          return '';
        }
      });
      await adapter.apply({ kind: 'migration', id: '20260912150000' });
      await adapter.apply({ kind: 'function', id: 'catalog-sync' });
      expect(calls[0]).toEqual(['db', 'push', '--linked', '--skip-vault']);
      expect(calls[1]).toEqual([
        'functions',
        'deploy',
        'catalog-sync',
        '--project-ref',
        'ref',
        '--use-api'
      ]);
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it('observes a migration as present only once the remote history has it', async () => {
    const root = await project({ 'supabase/migrations/20260912150000_x.sql': 'select 1;' });
    try {
      const adapter = createSupabaseBackendAdapter({
        projectRef: 'ref',
        targetId: 'production',
        root,
        accessToken: 'token',
        run: () => MIGRATIONS
      });
      expect(await adapter.observe({ kind: 'migration', id: '20260907140000' })).toMatchObject({
        historyPresent: true,
        postconditionsPass: true,
        targetId: 'production'
      });
      // Present locally, absent remotely: the apply did not take.
      expect(await adapter.observe({ kind: 'migration', id: '20260912150000' })).toMatchObject({
        historyPresent: false,
        postconditionsPass: false
      });
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it('tells a deployed function from one that is deployed and not serving', async () => {
    const root = await project({
      'supabase/functions/catalog-sync/index.ts': 'export const a = 1;'
    });
    try {
      const adapter = createSupabaseBackendAdapter({
        projectRef: 'ref',
        targetId: 'production',
        root,
        accessToken: 'token',
        run: () => FUNCTIONS
      });
      expect(await adapter.observe({ kind: 'function', id: 'catalog-sync' })).toMatchObject({
        historyPresent: true,
        postconditionsPass: true
      });
      expect(await adapter.observe({ kind: 'function', id: 'preview-warm' })).toMatchObject({
        historyPresent: true,
        postconditionsPass: false
      });
      expect(await adapter.observe({ kind: 'function', id: 'never-deployed' })).toMatchObject({
        historyPresent: false,
        provenAbsent: true
      });
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  it('refuses to exist without a destination or a way to reach it', () => {
    expect(() =>
      createSupabaseBackendAdapter({ projectRef: '', targetId: 'production', accessToken: 'token' })
    ).toThrow('no project ref');
    expect(() =>
      createSupabaseBackendAdapter({ projectRef: 'ref', targetId: 'production', accessToken: '' })
    ).toThrow('no Supabase access token');
  });
});
