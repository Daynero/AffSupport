import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';
let db: TeamTestDb;
beforeAll(async () => {
  db = await createTeamTestDb({ supabaseServiceDefaultPrivileges: true });
}, 120000);
afterAll(async () => {
  await db?.close();
});
const views = ['analytics_recovery_execution', 'analytics_process_output_cleanup'] as const;
it.each(views)('keeps %s read-only despite Supabase default privileges', async view => {
  const row = (
    await db.root<{ read: boolean; write: boolean }>(
      "select has_table_privilege('service_role',$1,'SELECT') read,has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE') write",
      [`public.${view}`]
    )
  )[0]!;
  expect(row).toEqual({ read: true, write: false });
});
it.each(views)('rejects an actual service-role delete through %s', async view => {
  await db.root('begin');
  try {
    await db.root('set local role service_role');
    await expect(db.root(`select * from public.${view} where false`)).resolves.toEqual([]);
    await expect(db.root(`delete from public.${view} where false`)).rejects.toThrow(
      /permission denied/
    );
  } finally {
    await db.root('rollback');
  }
});
