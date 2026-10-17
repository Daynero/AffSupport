import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it.each([false, true])(
  'preserves uniqueness and FK dependencies (duplicate referenced: %s)',
  async referenced => {
    const db = await PGlite.create();
    try {
      const first = referenced ? 'team_agents_tenant_key' : 'team_account_agents_id_team_unique';
      const second = referenced ? 'team_account_agents_id_team_unique' : 'team_agents_tenant_key';
      await db.exec(`
      create table public.team_account_agents(id int, team_id int, constraint ${first} unique(id, team_id));
      create table public.child(agent int, team_id int, foreign key(agent,team_id) references public.team_account_agents(id,team_id));
      alter table public.team_account_agents add constraint ${second} unique(id,team_id);
      insert into public.team_account_agents values(1, 2);
      insert into public.child values(1, 2);
    `);
      await db.exec(
        await readFile('supabase/migrations/20261202111000_agent_tenant_index_dedup.sql', 'utf8')
      );
      const constraints = await db.query(
        "select conname from pg_constraint where conrelid='public.team_account_agents'::regclass and contype='u'"
      );
      expect(constraints.rows).toHaveLength(referenced ? 2 : 1);
      await expect(db.exec('insert into public.team_account_agents values(1,2)')).rejects.toThrow();
      await expect(db.exec('insert into public.child values(99,2)')).rejects.toThrow();
      expect((await db.query('select * from public.child')).rows).toEqual([
        { agent: 1, team_id: 2 }
      ]);
    } finally {
      await db.close();
    }
  }
);
