import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Contract tests for the four SQL functions added by 010
 * (specs/010-team-ux-refresh/contracts/rpc-and-backend.md), run against a real
 * Postgres with every repository migration applied.
 *
 * These assert the guards, not the happy path alone: an owner cannot strand a
 * space, a "draft" is a server fact rather than a lobby label, and a caller who
 * is not a member cannot learn whether a space exists.
 */

const OWNER = '10000000-0000-4000-8000-000000000001';
const MEMBER = '10000000-0000-4000-8000-000000000002';
const STRANGER = '10000000-0000-4000-8000-000000000003';

let harness: TeamTestDb;

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: OWNER, email: 'owner@example.test', displayName: 'Owner' });
  await createUser(harness, { id: MEMBER, email: 'member@example.test', displayName: 'Member' });
  await createUser(harness, {
    id: STRANGER,
    email: 'stranger@example.test',
    displayName: 'Stranger'
  });
  // Team mode sits behind an admin allowlist (docs/BETA.md): `create_team`
  // requires an admin caller, and `private.can` only grants inside a space that
  // has an admin member. Making the owner an admin reproduces the real
  // arrangement rather than working around the gate.
  await harness.root(`insert into public.admin_users (user_id) values ($1)`, [OWNER]);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/**
 * A space owned by OWNER, with MEMBER joined at the given role.
 *
 * Creation goes through `create_team` rather than raw inserts because the owner
 * membership invariant is a deferred constraint trigger: the team row and its
 * owner membership have to land in the same transaction, which is exactly what
 * that function guarantees.
 */
async function makeSpace(name: string, memberRole: string | null = 'admin'): Promise<string> {
  const rows = await harness.asUser<{ id: string }>(
    OWNER,
    'select id from public.create_team($1)',
    [name]
  );
  const teamId = rows[0]!.id;
  if (memberRole) {
    await harness.root(
      `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, $3)`,
      [teamId, MEMBER, memberRole]
    );
  }
  return teamId;
}

/** Attach a drive connection, which is what makes a space stop being a draft. */
async function connectDrive(teamId: string, state = 'connected'): Promise<void> {
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ($1, $2, 'https://www.googleapis.com/auth/drive', gen_random_uuid(), $3)
     returning id`,
    [`perm-${teamId}`, 'owner@example.test', OWNER]
  );
  // `detached_at` is constrained to match the state, so a detached fixture must
  // carry a timestamp and a live one must not.
  await harness.root(
    `insert into public.team_drive_connections
       (team_id, credential_id, root_folder_id, root_folder_name, drive_kind,
        state, connected_at, detached_at)
     values ($1, $2, 'root-folder', 'Root', 'my_drive', $3, now(),
             case when $3 = 'detached' then now() else null end)`,
    [teamId, credential[0]!.id, state]
  );
}

describe('leave_team', () => {
  it('lets a member leave and warns that Drive access is not revoked', async () => {
    const teamId = await makeSpace('leave-ok');
    const rows = await harness.asUser<{ ok: boolean; warning_code: string }>(
      MEMBER,
      'select * from public.leave_team($1)',
      [teamId]
    );
    expect(rows[0]).toEqual({ ok: true, warning_code: 'EXTERNAL_DRIVE_ACCESS_REMAINS' });

    const remaining = await harness.root<{ status: string }>(
      `select status from public.team_members where team_id = $1 and user_id = $2`,
      [teamId, MEMBER]
    );
    expect(remaining[0]?.status).toBe('removed');
  });

  it('revokes the leaver’s reads', async () => {
    const teamId = await makeSpace('leave-revokes');
    const before = await harness.asUser<{ can: boolean }>(
      MEMBER,
      `select private.can($1, 'view', $2) as can`,
      [teamId, MEMBER]
    );
    expect(before[0]?.can).toBe(true);

    await harness.asUser(MEMBER, 'select * from public.leave_team($1)', [teamId]);

    const after = await harness.asUser<{ can: boolean }>(
      MEMBER,
      `select private.can($1, 'view', $2) as can`,
      [teamId, MEMBER]
    );
    expect(after[0]?.can).toBe(false);
  });

  it('refuses the owner, who would strand the space', async () => {
    const teamId = await makeSpace('leave-owner');
    await expect(
      harness.asUser(OWNER, 'select * from public.leave_team($1)', [teamId])
    ).rejects.toThrow(/OWNER_TRANSFER_REQUIRED/);
  });

  it('answers a non-member identically for an absent and an existing space', async () => {
    const teamId = await makeSpace('leave-stranger');
    const existing = await harness
      .asUser(STRANGER, 'select * from public.leave_team($1)', [teamId])
      .catch((error: unknown) => String(error));
    const absent = await harness
      .asUser(STRANGER, 'select * from public.leave_team($1)', [
        '10000000-0000-4000-8000-0000000000ff'
      ])
      .catch((error: unknown) => String(error));
    expect(existing).toMatch(/NOT_FOUND/);
    // Byte-identical: the error must not reveal that one of these spaces exists.
    expect(existing).toEqual(absent);
  });

  it('writes a membership.left audit row', async () => {
    const teamId = await makeSpace('leave-audit');
    await harness.asUser(MEMBER, 'select * from public.leave_team($1)', [teamId]);
    const audit = await harness.root<{ action: string; actor_id: string }>(
      `select action, actor_id from public.team_audit_events
       where team_id = $1 and action = 'membership.left'`,
      [teamId]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(MEMBER);
  });
});

describe('delete_draft_team', () => {
  it('deletes a space that never had a drive connection, with its memberships', async () => {
    const teamId = await makeSpace('draft-delete');
    const rows = await harness.asUser<{ ok: boolean }>(
      OWNER,
      'select * from public.delete_draft_team($1)',
      [teamId]
    );
    expect(rows[0]?.ok).toBe(true);

    const teams = await harness.root(`select id from public.teams where id = $1`, [teamId]);
    expect(teams).toHaveLength(0);
    const members = await harness.root(`select id from public.team_members where team_id = $1`, [
      teamId
    ]);
    expect(members).toHaveLength(0);
  });

  it('refuses a space that has ever had a connection, even a detached one', async () => {
    const teamId = await makeSpace('draft-connected');
    await connectDrive(teamId, 'detached');
    await expect(
      harness.asUser(OWNER, 'select * from public.delete_draft_team($1)', [teamId])
    ).rejects.toThrow(/TEAM_NOT_DRAFT/);

    const teams = await harness.root(`select id from public.teams where id = $1`, [teamId]);
    expect(teams).toHaveLength(1);
  });

  it('refuses a non-owner member and hides the space from a stranger', async () => {
    const teamId = await makeSpace('draft-permissions');
    await expect(
      harness.asUser(MEMBER, 'select * from public.delete_draft_team($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(
      harness.asUser(STRANGER, 'select * from public.delete_draft_team($1)', [teamId])
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('delete_team_task', () => {
  async function makeTask(teamId: string, title: string): Promise<string> {
    const rows = await harness.root<{ id: string }>(
      `insert into public.team_tasks (team_id, created_by, title) values ($1, $2, $3) returning id`,
      [teamId, OWNER, title]
    );
    return rows[0]!.id;
  }

  it('deletes the task and its attachment links, leaving the materials alone', async () => {
    const teamId = await makeSpace('task-delete');
    await connectDrive(teamId);
    const connection = await harness.root<{ id: string }>(
      `select id from public.team_drive_connections where team_id = $1`,
      [teamId]
    );
    const material = await harness.root<{ id: string }>(
      `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
       values ($1, $2, 'file-1', 'brief.pdf', 'file') returning id`,
      [teamId, connection[0]!.id]
    );
    const taskId = await makeTask(teamId, 'Ship the banner');
    await harness.root(
      `insert into public.team_task_attachments (team_id, task_id, material_id, position, attached_by)
       values ($1, $2, $3, 0, $4)`,
      [teamId, taskId, material[0]!.id, OWNER]
    );

    const rows = await harness.asUser<{ ok: boolean }>(
      OWNER,
      'select * from public.delete_team_task($1, $2)',
      [teamId, taskId]
    );
    expect(rows[0]?.ok).toBe(true);

    expect(await harness.root(`select id from public.team_tasks where id = $1`, [taskId])).toEqual(
      []
    );
    expect(
      await harness.root(`select id from public.team_task_attachments where task_id = $1`, [taskId])
    ).toEqual([]);
    // The file itself is untouched — detaching has never meant deleting.
    expect(
      await harness.root(`select id from public.team_materials where id = $1`, [material[0]!.id])
    ).toHaveLength(1);
  });

  it('honors the edit permission', async () => {
    const teamId = await makeSpace('task-permission', 'viewer');
    const taskId = await makeTask(teamId, 'Viewer may not delete this');
    await expect(
      harness.asUser(MEMBER, 'select * from public.delete_team_task($1, $2)', [teamId, taskId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('refuses a task from another space', async () => {
    const teamId = await makeSpace('task-owner-space');
    const otherId = await makeSpace('task-other-space');
    const taskId = await makeTask(otherId, 'Belongs elsewhere');
    await expect(
      harness.asUser(OWNER, 'select * from public.delete_team_task($1, $2)', [teamId, taskId])
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('writes a task.deleted audit row carrying the title snapshot', async () => {
    const teamId = await makeSpace('task-audit');
    const taskId = await makeTask(teamId, 'Audited task');
    await harness.asUser(OWNER, 'select * from public.delete_team_task($1, $2)', [teamId, taskId]);
    const audit = await harness.root<{ target: { task_title: string } }>(
      `select target from public.team_audit_events where team_id = $1 and action = 'task.deleted'`,
      [teamId]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target.task_title).toBe('Audited task');
  });
});

describe('list_team_trashed_materials', () => {
  async function trashedSpace(name: string, count: number): Promise<string> {
    const teamId = await makeSpace(name);
    await connectDrive(teamId);
    const connection = await harness.root<{ id: string }>(
      `select id from public.team_drive_connections where team_id = $1`,
      [teamId]
    );
    await harness.root(
      `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
       values ($1, $2, 'folder-1', 'Campaign', 'folder')`,
      [teamId, connection[0]!.id]
    );
    for (let index = 0; index < count; index += 1) {
      await harness.root(
        `insert into public.team_materials
           (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, lifecycle, trashed_at)
         values ($1, $2, $3, 'folder-1', $4, 'file', 'trashed', now() - ($5 || ' minutes')::interval)`,
        [teamId, connection[0]!.id, `file-${index}`, `asset-${index}.png`, String(index)]
      );
    }
    return teamId;
  }

  it('returns trashed rows newest-first with the parent folder hint', async () => {
    const teamId = await trashedSpace('trash-list', 3);
    const rows = await harness.asUser<{ name: string; parent_path_hint: string }>(
      MEMBER,
      'select * from public.list_team_trashed_materials($1)',
      [teamId]
    );
    expect(rows.map(row => row.name)).toEqual(['asset-0.png', 'asset-1.png', 'asset-2.png']);
    expect(rows.every(row => row.parent_path_hint === 'Campaign')).toBe(true);
  });

  it('omits active materials', async () => {
    const teamId = await trashedSpace('trash-active', 1);
    const connection = await harness.root<{ id: string }>(
      `select id from public.team_drive_connections where team_id = $1`,
      [teamId]
    );
    await harness.root(
      `insert into public.team_materials (team_id, connection_id, drive_file_id, name, kind)
       values ($1, $2, 'live-1', 'still-here.png', 'file')`,
      [teamId, connection[0]!.id]
    );
    const rows = await harness.asUser<{ name: string }>(
      MEMBER,
      'select * from public.list_team_trashed_materials($1)',
      [teamId]
    );
    expect(rows.map(row => row.name)).toEqual(['asset-0.png']);
  });

  it('pages with a keyset cursor', async () => {
    const teamId = await trashedSpace('trash-paging', 4);
    const first = await harness.asUser<{ name: string; trashed_at: string }>(
      MEMBER,
      'select * from public.list_team_trashed_materials($1, 2)',
      [teamId]
    );
    expect(first.map(row => row.name)).toEqual(['asset-0.png', 'asset-1.png']);
    const next = await harness.asUser<{ name: string }>(
      MEMBER,
      'select * from public.list_team_trashed_materials($1, 2, $2)',
      [teamId, first[1]!.trashed_at]
    );
    expect(next.map(row => row.name)).toEqual(['asset-2.png', 'asset-3.png']);
  });

  it('requires the view permission', async () => {
    const teamId = await trashedSpace('trash-permission', 1);
    await expect(
      harness.asUser(STRANGER, 'select * from public.list_team_trashed_materials($1)', [teamId])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('rejects an out-of-range page size', async () => {
    const teamId = await trashedSpace('trash-limit', 1);
    await expect(
      harness.asUser(MEMBER, 'select * from public.list_team_trashed_materials($1, 0)', [teamId])
    ).rejects.toThrow(/INVALID_INPUT/);
  });
});
