import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDisposablePostgresContainer } from './support/disposable-postgres';

const container = process.env.SOTY_PROCESS_POSTGRES_CONTAINER;
const migration = readFileSync(
  'supabase/migrations/20261206149200_search_excludes_cache_subtrees.sql',
  'utf8'
);

async function apply(sql: string) {
  assertDisposablePostgresContainer(container);
  const child = execFile(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'supabase_admin',
      '-d',
      'postgres'
    ],
    { timeout: 15000 }
  );
  const result = new Promise<string>((resolve, reject) => {
    let output = '',
      error = '';
    child.stdout!.on('data', value => {
      output += String(value);
    });
    child.stderr!.on('data', value => {
      error += String(value);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(error))));
  });
  child.stdin!.end(`begin; set local role postgres; ${sql} rollback;`);
  return result;
}

describe.skipIf(!container)('search migration role [needs: disposable PostgreSQL]', () => {
  it('registers the extension parameter before defining search as the actual CLI role', async () => {
    const definition = migration
      .slice(migration.indexOf('create or replace function'))
      .replace('public.search_materials(', 'pg_temp.soty_search_migration_probe(');
    await expect(apply(definition)).rejects.toThrow('permission denied to set parameter');
    const preload = migration.slice(0, migration.indexOf('create or replace function'));
    await expect(apply(preload + definition)).resolves.toBe('');
  });
});
