import { describe, expect, it } from 'vitest';
import {
  BASELINE,
  judgeMigrations,
  readMigrations
} from '../scripts/check-migrations-additive.mjs';

describe('migrations may only add (051)', () => {
  it('passes every migration in the repository', () => {
    expect(judgeMigrations(readMigrations('supabase/migrations')).blocked).toEqual([]);
  });

  it('blocks a drop, rename or tightening after the baseline and names the file', () => {
    const later = `${String(Number(BASELINE) + 1000)}`;
    const { blocked } = judgeMigrations([
      { name: `${later}_drop.sql`, sql: 'alter table public.tasks drop column title;' },
      { name: `${later}_rename.sql`, sql: 'alter table public.tasks rename column a to b;' },
      { name: `${later}_add.sql`, sql: 'alter table public.tasks add column note text;' }
    ]);
    expect(blocked.map(entry => entry.name)).toEqual([`${later}_drop.sql`, `${later}_rename.sql`]);
  });

  it('ignores migrations at or before the baseline and lets a marked cleanup through', () => {
    const later = `${String(Number(BASELINE) + 1000)}`;
    const result = judgeMigrations([
      { name: `${BASELINE}_old.sql`, sql: 'alter table public.tasks drop column title;' },
      {
        name: `${later}_cleanup.sql`,
        sql: '-- soty:cleanup\nalter table public.tasks drop column legacy;'
      }
    ]);
    expect(result.blocked).toEqual([]);
    expect(result.cleanups.map(entry => entry.name)).toEqual([`${later}_cleanup.sql`]);
  });
});
