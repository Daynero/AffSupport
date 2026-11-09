import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTeamTestDb, type TeamTestDb } from './support/team-db';
let db: TeamTestDb, contract: string;
beforeAll(async () => {
  db = await createTeamTestDb();
  const sql = await readFile('supabase/tests/database/team-restitch.test.sql', 'utf8');
  contract = sql.split('-- BEGIN caller ACL contract')[1]!.split('-- END caller ACL contract')[0]!;
  // Execute the actual pgTAP contract expressions on real Postgres. The native
  // runner supplies pgTAP; this isolated harness needs only its boolean assertion.
  await db.root(
    "create function public.ok(boolean,text) returns boolean language plpgsql as $$begin if $1 is distinct from true then raise exception 'ACL_CONTRACT_FAILED';end if;return true;end$$"
  );
}, 60000);
afterAll(async () => {
  await db?.close();
});
it('keeps explicit original caller grants and denies the revoked legacy inners', async () => {
  const rows = await db.db.exec(contract);
  expect(rows).toHaveLength(2);
});
it('detects a leaked legacy inner instead of masking it with a naming filter', async () => {
  await db.root(
    'grant execute on function public.prepare_launch_restitch_before_video(uuid,uuid,uuid[]) to authenticated'
  );
  try {
    await expect(db.db.exec(contract)).rejects.toThrow('ACL_CONTRACT_FAILED');
  } finally {
    await db.root(
      'revoke execute on function public.prepare_launch_restitch_before_video(uuid,uuid,uuid[]) from authenticated'
    );
  }
});
it('detects a missing outer caller grant instead of passing a smaller selected set', async () => {
  await db.root(
    'revoke execute on function public.prepare_launch_restitch(uuid,uuid,uuid[]) from authenticated'
  );
  try {
    await expect(db.db.exec(contract)).rejects.toThrow('ACL_CONTRACT_FAILED');
  } finally {
    await db.root(
      'grant execute on function public.prepare_launch_restitch(uuid,uuid,uuid[]) to authenticated'
    );
  }
});
