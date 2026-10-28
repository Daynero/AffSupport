import { randomUUID } from 'node:crypto';
import type { TeamTestDb } from './team-db';

/** Explicit fixture acceptance; saving a production draft never assigns an RK. */
export async function assignLaunchFixture(
  db: TeamTestDb,
  actor: string,
  team: string,
  launch: string,
  agent: string
): Promise<string> {
  const state = (
    await db.asUser<{ v: { version: string } }>(
      actor,
      'select public.get_launch_assignment($1,$2) v',
      [team, launch]
    )
  )[0]!.v;
  await db.asUser(actor, 'select public.set_launch_assignment($1,$2,$3,$4,$5)', [
    team,
    launch,
    agent,
    state.version,
    randomUUID()
  ]);
  return (
    await db.asUser<{ v: { version: string } }>(actor, 'select public.get_launch($1,$2,null) v', [
      team,
      launch
    ])
  )[0]!.v.version;
}
