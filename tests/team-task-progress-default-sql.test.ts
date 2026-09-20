import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * A new task's maximum is the space's (024,
 * supabase/migrations/20260916150000_task_progress_max_per_space.sql).
 *
 * It was the person's: saved from a task, it fixed the figure for whoever
 * pressed the button, and a teammate's next task still started at 100. These
 * hold the one thing the editor cannot see for itself — that the task someone
 * *else* creates starts from what was saved — and who may change it.
 */

const OWNER = '24150000-0000-4000-8000-000000000001';
const EDITOR = '24150000-0000-4000-8000-000000000002';
const STRANGER = '24150000-0000-4000-8000-000000000003';
const VIEWER = '24150000-0000-4000-8000-000000000004';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@max.test', displayName: 'Owner' });
  await createUser(harness, { id: EDITOR, email: 'editor@max.test', displayName: 'Editor' });
  await createUser(harness, { id: STRANGER, email: 'stranger@max.test', displayName: 'Stranger' });
  await createUser(harness, { id: VIEWER, email: 'viewer@max.test', displayName: 'Viewer' });
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function makeSpace(name: string): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    [name]
  );
  const teamId = rows[0]!.id;
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'editor')`,
    [teamId, EDITOR]
  );
  await harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, 'viewer')`,
    [teamId, VIEWER]
  );
  return teamId;
}

async function readDefault(as: string, teamId: string): Promise<number> {
  const rows = await harness.asUser<{ value: number }>(
    as,
    'select public.get_team_task_progress_max_default($1) as value',
    [teamId]
  );
  return Number(rows[0]!.value);
}

describe('the space’s progress maximum', () => {
  it('starts at 100, and every task anyone creates starts from what was saved', async () => {
    const teamId = await makeSpace('max-shared');
    expect(await readDefault(EDITOR, teamId)).toBe(100);

    await harness.asUser(OWNER, 'select public.set_team_task_progress_max_default($1, $2)', [
      teamId,
      250
    ]);
    expect(await readDefault(EDITOR, teamId)).toBe(250);

    const created = await harness.asUser<{ progress_max: number }>(
      EDITOR,
      'select progress_max from public.create_team_task($1, $2)',
      [teamId, 'Made by a teammate']
    );
    expect(Number(created[0]!.progress_max)).toBe(250);
  });

  it('belongs to one space only', async () => {
    const first = await makeSpace('max-first');
    const second = await makeSpace('max-second');
    await harness.asUser(OWNER, 'select public.set_team_task_progress_max_default($1, $2)', [
      first,
      40
    ]);
    expect(await readDefault(OWNER, second)).toBe(100);
  });

  it('is changed only by someone who may change the space’s settings (an editor may, a viewer may not)', async () => {
    const teamId = await makeSpace('max-guarded');
    await expect(
      harness.asUser(VIEWER, 'select public.set_team_task_progress_max_default($1, $2)', [
        teamId,
        20
      ])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(readDefault(STRANGER, teamId)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(OWNER, 'select public.set_team_task_progress_max_default($1, $2)', [teamId, 0])
    ).rejects.toThrow(/INVALID_INPUT/);
  });
});
