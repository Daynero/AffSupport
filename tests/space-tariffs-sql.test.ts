import { setQueryExecutor } from '../scripts/analytics/db';
import { getRecoveryEvidence } from '../scripts/analytics/tariff-recovery';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTeamTestDb, createUser, type TeamTestDb } from './support/team-db';

/**
 * Feature 034 — space tariffs in the database (specs/034-space-tariffs, plan R1–R15).
 *
 * The gate, the state people see, seats, the admin RPCs and their history, the background work a
 * suspended space must not start, and the letters queue — against a real Postgres with every
 * migration applied. Time-dependent rules are exercised through `p_at` where a function takes it,
 * and through end dates relative to the Kyiv "today" where it reads `now()`.
 */

let harness: TeamTestDb;
let seq = 0;

const ADMIN = '34000000-0000-4000-8000-000000000001';
const STAFF = '34000000-0000-4000-8000-000000000002';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** A fresh confirmed account. */
async function person(label: string, admin = false): Promise<{ id: string; email: string }> {
  seq += 1;
  const id = `34000000-0000-4000-8000-${String(1000 + seq).padStart(12, '0')}`;
  const email = `${label}-${seq}@tariffs.test`;
  await createUser(harness, { id, email, displayName: `${label} ${seq}` });
  if (admin) {
    await harness.root('insert into public.admin_users (user_id) values ($1)', [id]);
  }
  return { id, email };
}

const day = async (offset: number): Promise<string> =>
  (
    await harness.root<{ d: string }>('select (private.kyiv_today() + $1::int)::text as d', [
      offset
    ])
  )[0]!.d;

const asAdmin = async <T = unknown>(sql: string, params: unknown[] = []): Promise<T> =>
  (await harness.asUser<{ r: T }>(ADMIN, `select ${sql} as r`, params))[0]!.r;

interface Row {
  id: string;
  state: string;
  endsOn: string;
  teamId: string | null;
  ownerId: string | null;
  seatsTotal: number;
  seatsUsed: number;
  revokedAt: string | null;
  legacyAlso: boolean;
  eventId?: string;
}

async function grant(
  email: string,
  plan: string,
  endsOn: string,
  options: { extra?: number; team?: string | null; notify?: boolean } = {}
): Promise<Row> {
  return asAdmin<Row>('public.admin_grant_space_tariff($1, $2, $3::date, $4, $5, null, null, $6)', [
    email,
    plan,
    endsOn,
    options.extra ?? 0,
    options.team ?? null,
    options.notify ?? false
  ]);
}

/** A space created by its owner under an unbound tariff, which binds it. */
async function tariffSpace(
  owner: { id: string; email: string },
  plan = 'lead',
  endsInDays = 30,
  extra = 0
): Promise<{ team: string; tariff: string }> {
  const row = await grant(owner.email, plan, await day(endsInDays), { extra });
  seq += 1;
  const team = (
    await harness.asUser<{ id: string }>(owner.id, 'select id from public.create_team($1)', [
      `Space ${seq}`
    ])
  )[0]!.id;
  return { team, tariff: row.id };
}

/** A space created outside create_team (the owner's membership lands in the same statement). */
async function rawTeam(owner: string, name: string): Promise<string> {
  return (
    await harness.root<{ id: string }>(
      `with created as (
         insert into public.teams (name, owner_id) values ($1, $2) returning id
       ), owner_member as (
         insert into public.team_members (team_id, user_id, base_role)
         select id, $2, 'admin' from created
       )
       select id from created`,
      [name, owner]
    )
  )[0]!.id;
}

const addMember = (team: string, user: string, role = 'editor') =>
  harness.root(
    `insert into public.team_members (team_id, user_id, base_role) values ($1, $2, $3)`,
    [team, user, role]
  );

const allowed = async (team: string) =>
  (
    await harness.root<{ ok: boolean }>('select private.team_workspace_allowed($1) as ok', [team])
  )[0]!.ok;

interface State {
  state: string;
  tariff_id: string | null;
  seats_total: number;
  seats_used: number;
  ends_on: string | null;
  days_left: number | null;
  legacy_also: boolean;
  pending_invites: number;
}

const stateOf = async (team: string, at: string | null = null): Promise<State> =>
  (
    await harness.root<State>(
      `select state, tariff_id, seats_total, seats_used, ends_on::text as ends_on, days_left,
              legacy_also, pending_invites
       from private.space_tariff_state($1, coalesce($2::timestamptz, now()))`,
      [team, at]
    )
  )[0]!;

const setTariff = (id: string, patch: string, params: unknown[] = []) =>
  harness.root(`update public.space_tariffs set ${patch} where id = $1`, [id, ...params]);

const setLegacy = (enabled: boolean) =>
  harness.root('update public.tariff_settings set legacy_rule_enabled = $1', [enabled]);

interface Access {
  mode: string;
  canCreate: boolean;
  pendingTariff: { planCode: string; endsOn: string } | null;
  teams: Array<{
    teamId: string;
    role: string;
    accessState: string;
    ownerName: string | null;
    tariff: Record<string, unknown>;
  }>;
  invitations: Array<{ invitationId: string; teamId: string; blocked: boolean }>;
  banner: null | {
    teamId: string;
    kind: string;
    endsOn: string;
    graceUntil: string;
    daysLeft: number;
  };
  toast: null | { kind: string; eventId: string; endsOn: string };
  showcase: {
    plans: Array<{ code: string; baseSeats: number }>;
    contact: { telegram: string | null; email: string | null };
    email: string;
    request: null | { planInterest: string | null; channel: string | null };
  };
}

const access = async (user: string): Promise<Access> =>
  (await harness.asUser<{ r: Access }>(user, 'select public.get_my_space_access() as r'))[0]!.r;

const hash = () => randomBytes(32);

const invite = (actor: string, team: string, email: string) =>
  harness.asUser<{ id: string }>(
    actor,
    `select id from public.create_invitation($1, $2, 'editor', $3)`,
    [team, email, hash()]
  );

async function connect(team: string): Promise<string> {
  seq += 1;
  const credential = await harness.root<{ id: string }>(
    `insert into private.google_drive_credentials
       (google_permission_id, google_account_email, scope, vault_secret_id, connected_by)
     values ($1, 'owner@tariffs.test', 'https://www.googleapis.com/auth/drive.file',
             gen_random_uuid(), $2)
     returning id`,
    [`perm-${seq}`, ADMIN]
  );
  return (
    await harness.root<{ id: string }>(
      `insert into public.team_drive_connections
         (team_id, credential_id, root_folder_id, root_folder_name, drive_kind, state, connected_at)
       values ($1, $2, 'root', 'Root', 'my_drive', 'connected', now())
       returning id`,
      [team, credential[0]!.id]
    )
  )[0]!.id;
}

async function material(
  team: string,
  connection: string,
  name: string,
  category: string | null,
  mime: string,
  extra: { parent?: string; kind?: string; driveFileId?: string } = {}
): Promise<string> {
  seq += 1;
  return (
    await harness.root<{ id: string }>(
      `insert into public.team_materials
         (team_id, connection_id, drive_file_id, parent_folder_id, name, kind, category, mime_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        team,
        connection,
        extra.driveFileId ?? `drive-${seq}`,
        extra.parent ?? 'root',
        name,
        extra.kind ?? 'file',
        category,
        mime
      ]
    )
  )[0]!.id;
}

async function catalog(team: string, connection: string, createdBy: string): Promise<string> {
  const video = await material(team, connection, 'clip.mp4', 'video', 'video/mp4');
  const sheet = await material(team, connection, 'clip catalog', 'other', SHEET_MIME);
  const record = {
    sourceLink: 'https://offer.example.test/?sub=1',
    productCount: 3,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    videoLink: 'https://drive.google.com/file/d/video/view?usp=sharing',
    settingsSnapshot: {
      title: 'T',
      description: 'D',
      price: 10,
      imageLink: 'https://i.test/a.png'
    },
    createdBy
  };
  const linked = await harness.root<{ result: { linked: boolean } }>(
    'select public.service_link_product_catalog_companion($1, $2, $3, null, $4) as result',
    [team, video, sheet, JSON.stringify(record)]
  );
  expect(linked[0]!.result.linked).toBe(true);
  return sheet;
}

beforeAll(async () => {
  harness = await createTeamTestDb();
  await createUser(harness, { id: ADMIN, email: 'admin@tariffs.test', displayName: 'Roman' });
  await createUser(harness, { id: STAFF, email: 'staff@tariffs.test', displayName: 'Staff' });
  await harness.root('insert into public.admin_users (user_id) values ($1), ($2)', [ADMIN, STAFF]);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------------------------

describe('time and state (R1)', () => {
  it('ends a tariff at the end of its Kyiv day, summer and winter', async () => {
    const rows = await harness.root<{ summer: string; winter: string; today: string }>(
      `select private.kyiv_day_end('2026-10-14')::text as summer,
              private.kyiv_day_end('2026-12-01')::text as winter,
              private.kyiv_today('2026-10-14T21:30:00Z') ::text as today`
    );
    expect(new Date(rows[0]!.summer).toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(new Date(rows[0]!.winter).toISOString()).toBe('2026-12-01T22:00:00.000Z');
    expect(rows[0]!.today).toBe('2026-10-15');
  });

  it('walks active → expiring → grace → blocked across Kyiv midnights', async () => {
    const owner = await person('state');
    const { team, tariff } = await tariffSpace(owner);
    await setTariff(tariff, `ends_on = '2026-10-14'`);
    const at = async (instant: string) => (await stateOf(team, instant)).state;

    expect(await at('2026-10-10T20:59:59Z')).toBe('active'); // 4 days left
    expect(await at('2026-10-10T21:00:00Z')).toBe('expiring'); // Oct 11 in Kyiv: 3 days
    const lastDay = await stateOf(team, '2026-10-14T20:59:59Z');
    expect(lastDay).toMatchObject({ state: 'expiring', days_left: 0 });
    const firstExtra = await stateOf(team, '2026-10-14T21:00:00Z');
    expect(firstExtra).toMatchObject({ state: 'grace', days_left: -1 });
    expect(await at('2026-10-17T20:59:59Z')).toBe('grace');
    expect(await at('2026-10-17T21:00:00Z')).toBe('blocked');
  });

  it('counts a revocation from its own instant', async () => {
    const owner = await person('revoke-at');
    const { team, tariff } = await tariffSpace(owner);
    await setTariff(tariff, `revoked_at = now() + interval '1 hour'`);
    expect((await stateOf(team)).state).toBe('active');
    expect((await stateOf(team, new Date(Date.now() + 2 * 3600_000).toISOString())).state).toBe(
      'blocked'
    );
  });
});

describe('the gate (R2)', () => {
  it('opens through the extra days and closes after them', async () => {
    const owner = await person('gate');
    const { team, tariff } = await tariffSpace(owner);
    expect(await allowed(team)).toBe(true);
    await setTariff(tariff, 'ends_on = $2::date', [await day(-3)]);
    expect(await allowed(team)).toBe(true);
    expect((await stateOf(team)).state).toBe('grace');
    await setTariff(tariff, 'ends_on = $2::date', [await day(-4)]);
    expect(await allowed(team)).toBe(false);
    expect((await stateOf(team)).state).toBe('blocked');
  });

  it('takes the roles away in a suspended space: team_role, can, list_my_teams, RLS reads', async () => {
    const owner = await person('roles');
    const member = await person('roles-member');
    const { team, tariff } = await tariffSpace(owner);
    await addMember(team, member.id, 'editor');
    const role = async (user: string) =>
      (
        await harness.asUser<{ role: string | null }>(
          user,
          'select private.team_role($1, $2) as role',
          [team, user]
        )
      )[0]!.role;
    const can = async (user: string) =>
      (
        await harness.asUser<{ ok: boolean }>(user, `select private.can($1, 'view', $2) as ok`, [
          team,
          user
        ])
      )[0]!.ok;
    const listed = async (user: string) =>
      (await harness.asUser<{ id: string }>(user, 'select id from public.list_my_teams()')).map(
        row => row.id
      );

    expect(await role(owner.id)).toBe('owner');
    expect(await role(member.id)).toBe('editor');
    expect(await can(member.id)).toBe(true);
    expect(await listed(member.id)).toContain(team);

    await setTariff(tariff, 'revoked_at = now()');
    expect(await role(owner.id)).toBeNull();
    expect(await role(member.id)).toBeNull();
    expect(await can(member.id)).toBe(false);
    expect(await listed(member.id)).not.toContain(team);
    await expect(
      harness.asUser(member.id, 'select * from public.list_team_members($1)', [team])
    ).rejects.toThrow(/PERMISSION_DENIED/);

    // The new web still sees the space, suspended.
    const view = await access(member.id);
    expect(view.mode).toBe('blocked');
    expect(view.teams.find(entry => entry.teamId === team)).toMatchObject({
      accessState: 'blocked',
      role: 'editor',
      tariff: { state: 'blocked', isOwner: false, endsOn: null }
    });
  });

  it('keeps every space with an admin member open while the legacy rule is on (default)', async () => {
    const owner = await person('legacy');
    const team = await rawTeam(owner.id, 'Legacy space');
    await addMember(team, STAFF, 'admin');
    expect(await allowed(team)).toBe(true);
    expect(await stateOf(team)).toMatchObject({
      state: 'legacy',
      tariff_id: null,
      seats_total: 50
    });

    // A short tariff under the legacy rule warns nobody (US2.2).
    const row = await grant(owner.email, 'lead', await day(1), { team });
    expect(row.state).toBe('legacy');
    expect(row.legacyAlso).toBe(true);
    expect((await access(owner.id)).banner).toBeNull();

    // A long one shows as active, with the legacy flag.
    await setTariff(row.id, 'ends_on = $2::date', [await day(40)]);
    expect(await stateOf(team)).toMatchObject({ state: 'active', legacy_also: true });

    // Revoked under the legacy rule: still open until the rule is switched off.
    await setTariff(row.id, 'revoked_at = now()');
    expect(await allowed(team)).toBe(true);
    expect((await stateOf(team)).state).toBe('legacy');
    await setLegacy(false);
    try {
      expect(await allowed(team)).toBe(false);
      expect((await stateOf(team)).state).toBe('blocked');
    } finally {
      await setLegacy(true);
    }
  });

  it('closes a legacy space without a tariff when the rule is off (state none)', async () => {
    const owner = await person('legacy-off');
    const team = await rawTeam(owner.id, 'Legacy only');
    await addMember(team, STAFF, 'viewer');
    await setLegacy(false);
    try {
      expect(await allowed(team)).toBe(false);
      expect((await stateOf(team)).state).toBe('none');
      expect((await access(owner.id)).mode).toBe('showcase');
    } finally {
      await setLegacy(true);
    }
  });

  it('opens an admin-owned space always, with no tariff (internal)', async () => {
    const team = (
      await harness.asUser<{ id: string }>(ADMIN, 'select id from public.create_team($1)', [
        'Internal'
      ])
    )[0]!.id;
    await setLegacy(false);
    try {
      expect(await allowed(team)).toBe(true);
      expect(await stateOf(team)).toMatchObject({ state: 'internal', seats_total: 50 });
    } finally {
      await setLegacy(true);
    }
  });

  it('does not count Soty admins as seats', async () => {
    const owner = await person('seats-admin');
    const { team } = await tariffSpace(owner, 'solo');
    await addMember(team, STAFF, 'admin');
    expect(await stateOf(team)).toMatchObject({ seats_total: 1, seats_used: 1 });
  });
});

describe('ownership and binding (R3, R12)', () => {
  it('lets only an admin or an owner with an unbound tariff create a space, binding it', async () => {
    const owner = await person('create');
    await expect(
      harness.asUser(owner.id, 'select * from public.create_team($1)', ['Nope'])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(
      await harness.asUser(owner.id, 'select public.can_access_team_workspace() as ok')
    ).toEqual([{ ok: false }]);

    const row = await grant(owner.email, 'lead', await day(30));
    expect(row.state).toBe('pending');
    const before = await access(owner.id);
    expect(before).toMatchObject({
      mode: 'workspace',
      canCreate: true,
      pendingTariff: { planCode: 'lead', endsOn: row.endsOn }
    });
    expect(
      await harness.asUser(owner.id, 'select public.can_access_team_workspace() as ok')
    ).toEqual([{ ok: true }]);

    const team = (
      await harness.asUser<{ id: string }>(owner.id, 'select id from public.create_team($1)', [
        'Mine'
      ])
    )[0]!.id;
    const bound = await harness.root<{ team_id: string; bound_at: string | null }>(
      'select team_id, bound_at from public.space_tariffs where id = $1',
      [row.id]
    );
    expect(bound[0]).toMatchObject({ team_id: team });
    expect(bound[0]!.bound_at).not.toBeNull();
    const events = await asAdmin<Array<{ kind: string }>>(
      'public.admin_list_space_tariff_events($1)',
      [row.id]
    );
    expect(events.map(event => event.kind)).toEqual(['bound', 'granted']);
    // The history reads as sentences: names come with the codes and ids.
    const named = events as unknown as Array<{ after: Record<string, unknown> }>;
    expect(named[0]!.after).toMatchObject({ teamName: 'Mine' });
    expect(named[1]!.after).toMatchObject({ planNameUk: expect.any(String) });
    expect((await access(owner.id)).canCreate).toBe(false);
    await expect(
      harness.asUser(owner.id, 'select * from public.create_team($1)', ['Second'])
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('does not create a space under a tariff whose date has passed', async () => {
    const owner = await person('create-late');
    const row = await grant(owner.email, 'solo', await day(0));
    await setTariff(row.id, 'ends_on = $2::date', [await day(-1)]);
    await expect(
      harness.asUser(owner.id, 'select * from public.create_team($1)', ['Late'])
    ).rejects.toThrow(/PERMISSION_DENIED/);
    const rows = await asAdmin<Row[]>('public.admin_list_space_tariffs()');
    expect(rows.find(entry => entry.id === row.id)?.state).toBe('pending_expired');
  });

  it('claims a tariff granted to an address at the first sign-in, case-insensitively', async () => {
    const row = await grant('Newcomer@Tariffs.TEST', 'solo', await day(10));
    expect(row.ownerId).toBeNull();
    const preview = await asAdmin<{ accountExists: boolean }>(
      'public.admin_preview_space_tariff($1, null)',
      ['newcomer@tariffs.test']
    );
    expect(preview.accountExists).toBe(false);

    const id = '34000000-0000-4000-8000-00000000beef';
    await createUser(harness, { id, email: 'newcomer@tariffs.test', displayName: 'Newcomer' });
    // The released web's own lobby check claims it.
    expect(await harness.asUser(id, 'select public.can_access_team_workspace() as ok')).toEqual([
      { ok: true }
    ]);
    const claimed = await harness.root<{ owner_id: string; claimed_at: string | null }>(
      'select owner_id, claimed_at from public.space_tariffs where id = $1',
      [row.id]
    );
    expect(claimed[0]!.owner_id).toBe(id);
    const events = await asAdmin<Array<{ kind: string }>>(
      'public.admin_list_space_tariff_events($1)',
      [row.id]
    );
    expect(events[0]!.kind).toBe('claimed');
  });

  it('revokes the tariff of an owner whose account is deleted', async () => {
    const owner = await person('deleted');
    const row = await grant(owner.email, 'solo', await day(10));
    await harness.root('delete from auth.users where id = $1', [owner.id]);
    const after = await harness.root<{ owner_id: string | null; revoked_at: string | null }>(
      'select owner_id, revoked_at from public.space_tariffs where id = $1',
      [row.id]
    );
    expect(after[0]!.owner_id).toBeNull();
    expect(after[0]!.revoked_at).not.toBeNull();
    const events = await asAdmin<Array<{ kind: string }>>(
      'public.admin_list_space_tariff_events($1)',
      [row.id]
    );
    expect(events[0]!.kind).toBe('owner_deleted');
  });

  it('refuses to transfer a space bound to a tariff', async () => {
    const owner = await person('transfer');
    const member = await person('transfer-to');
    const { team } = await tariffSpace(owner);
    await addMember(team, member.id, 'admin');
    await expect(
      harness.asUser(owner.id, `select * from public.transfer_ownership($1, $2, 'admin')`, [
        team,
        member.id
      ])
    ).rejects.toThrow(/TARIFF_BOUND/);
  });
});

describe('seats (R5)', () => {
  it('counts invitations as seats and stops at the plan: create, resend, accept', async () => {
    const owner = await person('seats');
    const first = await person('seats-first');
    const second = await person('seats-second');
    const third = await person('seats-third');
    const { team } = await tariffSpace(owner, 'lead');

    const one = (await invite(owner.id, team, first.email))[0]!.id;
    await invite(owner.id, team, second.email);
    expect(await stateOf(team)).toMatchObject({
      seats_total: 3,
      seats_used: 3,
      pending_invites: 2
    });
    await expect(invite(owner.id, team, third.email)).rejects.toThrow(/SEATS_FULL/);

    // Accepting uses the seat its invitation already held.
    await harness.asUser(first.id, 'select * from public.accept_invitation($1)', [one]);
    expect(await stateOf(team)).toMatchObject({ seats_used: 3, pending_invites: 1 });

    // A lapsed invitation frees its seat; sending it again needs one.
    const lapsed = (
      await harness.root<{ id: string }>(
        `update public.team_invitations set expires_at = now() - interval '1 minute',
                created_at = now() - interval '15 days'
         where team_id = $1 and state = 'pending' returning id`,
        [team]
      )
    )[0]!.id;
    expect((await stateOf(team)).seats_used).toBe(2);
    await addMember(team, third.id);
    await expect(
      harness.asUser(owner.id, `select * from public.resend_invitation($1, $2)`, [lapsed, hash()])
    ).rejects.toThrow(/SEATS_FULL/);
  });

  it('refuses an acceptance once the members alone fill the plan', async () => {
    const owner = await person('accept-full');
    const guest = await person('accept-guest');
    const extra = await person('accept-extra');
    const { team, tariff } = await tariffSpace(owner, 'lead');
    const invitation = (await invite(owner.id, team, guest.email))[0]!.id;
    await addMember(team, extra.id);
    await addMember(team, (await person('accept-third')).id);
    expect((await stateOf(team)).seats_used).toBe(4);
    await expect(
      harness.asUser(guest.id, 'select * from public.accept_invitation($1)', [invitation])
    ).rejects.toThrow(/SEATS_FULL/);

    // A suspended space accepts nobody.
    await setTariff(tariff, 'revoked_at = now()');
    await expect(
      harness.asUser(guest.id, 'select * from public.accept_invitation($1)', [invitation])
    ).rejects.toThrow(/SPACE_BLOCKED/);
    const view = await access(guest.id);
    expect(view.invitations.find(entry => entry.invitationId === invitation)?.blocked).toBe(true);
  });

  it('keeps Solo to its owner, and lets extra seats in', async () => {
    const owner = await person('solo');
    const guest = await person('solo-guest');
    const { team, tariff } = await tariffSpace(owner, 'solo');
    await expect(invite(owner.id, team, guest.email)).rejects.toThrow(/SEATS_FULL/);
    const tariffJson = (
      await harness.asUser<{ r: { canInvite: boolean; seatsTotal: number } }>(
        owner.id,
        'select public.get_team_tariff($1) as r',
        [team]
      )
    )[0]!.r;
    expect(tariffJson).toMatchObject({ canInvite: false, seatsTotal: 1 });

    await asAdmin('public.admin_update_space_tariff($1, null, null, 1, null, null)', [tariff]);
    await invite(owner.id, team, guest.email);
    expect(
      (
        await harness.asUser<{ r: { canInvite: boolean } }>(
          owner.id,
          'select public.get_team_tariff($1) as r',
          [team]
        )
      )[0]!.r.canInvite
    ).toBe(true);
  });

  it('refuses a direct add past the seats', async () => {
    const owner = await person('direct');
    const guest = await person('direct-guest');
    const { team } = await tariffSpace(owner, 'solo');
    await expect(
      harness.root(
        `select * from public.service_direct_add_registered_member($1, $2, $3, 'editor')`,
        [owner.id, team, guest.email]
      )
    ).rejects.toThrow(/SEATS_FULL/);
  });

  it('refuses fewer seats than are in use (SEATS_IN_USE) and suggests extra ones', async () => {
    const owner = await person('in-use');
    const team = await rawTeam(owner.id, 'Busy legacy');
    await addMember(team, STAFF, 'admin');
    for (let index = 0; index < 3; index += 1) {
      await addMember(team, (await person('in-use-member')).id);
    }
    const preview = await asAdmin<{
      seatsUsed: number;
      suggestedExtraSeats: number;
      occupants: Array<{ kind: string }>;
    }>('public.admin_preview_space_tariff($1, $2)', [owner.email, team]);
    expect(preview).toMatchObject({ seatsUsed: 4, suggestedExtraSeats: 1 });
    expect(preview.occupants).toHaveLength(5); // the admin member is listed but takes no seat
    await expect(grant(owner.email, 'lead', await day(30), { team })).rejects.toThrow(
      /SEATS_IN_USE/
    );
    const row = await grant(owner.email, 'lead', await day(30), { team, extra: 1 });
    expect(row).toMatchObject({ seatsTotal: 4, seatsUsed: 4 });
    await expect(
      asAdmin('public.admin_update_space_tariff($1, null, null, 0, null, null)', [row.id])
    ).rejects.toThrow(/SEATS_IN_USE/);
  });
});

describe('admin RPCs (FR-005)', () => {
  it('refuses everyone who is not an admin', async () => {
    const someone = await person('not-admin');
    for (const call of [
      'public.admin_list_space_tariffs()',
      'public.admin_list_tariff_plans()',
      'public.admin_get_tariff_settings()',
      'public.admin_list_legacy_spaces()',
      'public.admin_list_space_requests()'
    ]) {
      await expect(harness.asUser(someone.id, `select ${call}`)).rejects.toThrow(
        /PERMISSION_DENIED/
      );
    }
    await expect(
      harness.asUser(
        someone.id,
        `select public.admin_grant_space_tariff('x@y.test', 'lead', current_date + 3, 0)`
      )
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('validates a grant: date, plan, duplicates', async () => {
    const owner = await person('grant-check');
    await expect(grant(owner.email, 'lead', await day(-1))).rejects.toThrow(/TARIFF_DATE_INVALID/);
    await expect(grant(owner.email, 'gold', await day(5))).rejects.toThrow(/INVALID_INPUT/);
    await expect(grant('not-an-email', 'lead', await day(5))).rejects.toThrow(/INVALID_INPUT/);
    await grant(owner.email, 'lead', await day(0));
    await expect(grant(owner.email, 'solo', await day(5))).rejects.toThrow(/TARIFF_BOUND/);
    const { team } = await tariffSpace(await person('grant-bound'));
    const holder = await harness.root<{ email: string }>(
      `select users.email from auth.users users join public.teams team on team.owner_id = users.id
       where team.id = $1`,
      [team]
    );
    await expect(grant(holder[0]!.email, 'lead', await day(5), { team })).rejects.toThrow(
      /TARIFF_BOUND/
    );
    const plans = await asAdmin<
      Array<{ code: string; baseSeats: number; invitesAllowed: boolean }>
    >('public.admin_list_tariff_plans()');
    expect(plans.map(plan => [plan.code, plan.baseSeats, plan.invitesAllowed])).toEqual([
      ['solo', 1, false],
      ['lead', 3, true]
    ]);
  });

  it('extends from the end date while open and from today once suspended, with undo', async () => {
    const owner = await person('extend');
    const { team, tariff } = await tariffSpace(owner, 'lead', 10);
    const endsOn = await day(10);
    const extended = await asAdmin<Row>('public.admin_extend_space_tariff($1, 1)', [tariff]);
    const expected = (
      await harness.root<{ d: string }>(`select ($1::date + interval '1 month')::date::text as d`, [
        endsOn
      ])
    )[0]!.d;
    expect(extended.endsOn).toBe(expected);
    expect(extended.eventId).toBeTruthy();

    const undone = await asAdmin<Row>('public.admin_undo_space_tariff_event($1)', [
      extended.eventId
    ]);
    expect(undone.endsOn).toBe(endsOn);
    // Only once, and only the latest.
    await expect(
      asAdmin('public.admin_undo_space_tariff_event($1)', [extended.eventId])
    ).rejects.toThrow(/INVALID_INPUT/);

    // Suspended: counted from today.
    await setTariff(tariff, 'ends_on = $2::date', [await day(-10)]);
    expect(await allowed(team)).toBe(false);
    const revived = await asAdmin<Row>('public.admin_extend_space_tariff($1, 1)', [tariff]);
    const fromToday = (
      await harness.root<{ d: string }>(
        `select (private.kyiv_today() + interval '1 month')::date::text as d`
      )
    )[0]!.d;
    expect(revived.endsOn).toBe(fromToday);
    expect(await allowed(team)).toBe(true);

    // An old event can no longer be undone.
    await harness.root(
      `update public.space_tariff_events set created_at = now() - interval '11 minutes' where id = $1`,
      [revived.eventId]
    );
    await expect(
      asAdmin('public.admin_undo_space_tariff_event($1)', [revived.eventId])
    ).rejects.toThrow(/INVALID_INPUT/);
    const events = await asAdmin<Array<{ kind: string; undoable: boolean; before: unknown }>>(
      'public.admin_list_space_tariff_events($1)',
      [tariff]
    );
    // The revived extension was moved eleven minutes back, so it sorts last.
    expect(events.map(event => event.kind)).toEqual([
      'undone',
      'extended',
      'bound',
      'granted',
      'extended'
    ]);
    expect(events.every(event => !event.undoable)).toBe(true);
  });

  it('ends today with the extra days, or closes now; undo reopens', async () => {
    const owner = await person('end');
    const { team, tariff } = await tariffSpace(owner, 'lead', 20);
    const today = await asAdmin<Row>('public.admin_end_space_tariff($1, false)', [tariff]);
    expect(today.endsOn).toBe(await day(0));
    expect(today.state).toBe('expiring');
    expect(await allowed(team)).toBe(true);

    const now = await asAdmin<Row>('public.admin_end_space_tariff($1, true)', [tariff]);
    expect(now.revokedAt).not.toBeNull();
    expect(now.state).toBe('blocked');
    expect(await allowed(team)).toBe(false);
    await expect(asAdmin('public.admin_end_space_tariff($1, true)', [tariff])).rejects.toThrow(
      /INVALID_INPUT/
    );

    const events = await asAdmin<Array<{ id: string; kind: string; undoable: boolean }>>(
      'public.admin_list_space_tariff_events($1)',
      [tariff]
    );
    expect(events[0]).toMatchObject({ kind: 'ended_now', undoable: true });
    const reopened = await asAdmin<Row>('public.admin_undo_space_tariff_event($1)', [
      events[0]!.id
    ]);
    expect(reopened.revokedAt).toBeNull();
    expect(await allowed(team)).toBe(true);
  });

  it('cancels a waiting grant', async () => {
    const row = await grant('waiting@tariffs.test', 'lead', await day(30));
    const cancelled = await asAdmin<Row>('public.admin_end_space_tariff($1, false)', [row.id]);
    expect(cancelled.revokedAt).not.toBeNull();
    // The address can be granted again.
    await grant('waiting@tariffs.test', 'lead', await day(30));
  });

  it('lists seats, removes a member (never the owner) and revokes an invitation', async () => {
    const owner = await person('seat-admin');
    const member = await person('seat-admin-member');
    const { team, tariff } = await tariffSpace(owner, 'lead');
    await addMember(team, member.id);
    const invitation = (await invite(owner.id, team, 'invitee@tariffs.test'))[0]!.id;
    const seats = await asAdmin<Array<{ kind: string; isOwner: boolean }>>(
      'public.admin_list_tariff_seats($1)',
      [team]
    );
    expect(seats.map(seat => seat.kind).sort()).toEqual(['invitation', 'member', 'member']);
    await expect(
      asAdmin('public.admin_remove_tariff_member($1, $2)', [team, owner.id])
    ).rejects.toThrow(/INVALID_INPUT/);
    expect(await asAdmin('public.admin_remove_tariff_member($1, $2)', [team, member.id])).toBe(
      true
    );
    expect(await asAdmin('public.admin_revoke_tariff_invitation($1)', [invitation])).toBe(true);
    expect((await stateOf(team)).seats_used).toBe(1);
    const kinds = (
      await asAdmin<Array<{ kind: string }>>('public.admin_list_space_tariff_events($1)', [tariff])
    ).map(event => event.kind);
    expect(kinds.slice(0, 2)).toEqual(['invitation_revoked', 'member_removed']);
    const audit = await harness.root<{ action: string }>(
      'select action from public.team_audit_events where team_id = $1 order by occurred_at',
      [team]
    );
    expect(audit.map(entry => entry.action)).toEqual(
      expect.arrayContaining(['membership.removed', 'invitation.revoked'])
    );
  });

  it('lists an owner’s spaces with their bound tariff', async () => {
    const owner = await person('owner-spaces');
    const { team, tariff } = await tariffSpace(owner);
    const spaces = await asAdmin<
      Array<{ teamId: string; boundTariffId: string; membersUsed: number }>
    >('public.admin_list_owner_spaces($1)', [owner.email.toUpperCase()]);
    expect(spaces).toEqual([
      { teamId: team, name: expect.any(String), membersUsed: 1, boundTariffId: tariff }
    ]);
  });

  it('lists legacy-only spaces and refuses to turn the rule off past them without confirmation', async () => {
    const owner = await person('legacy-list');
    const team = await rawTeam(owner.id, 'Held by the rule');
    await addMember(team, STAFF, 'admin');
    const legacy = await asAdmin<Array<{ teamId: string; ownerEmail: string }>>(
      'public.admin_list_legacy_spaces()'
    );
    expect(legacy.find(entry => entry.teamId === team)?.ownerEmail).toBe(owner.email);

    const settings = await asAdmin<{ legacyRuleEnabled: boolean; legacySpacesRemaining: number }>(
      'public.admin_get_tariff_settings()'
    );
    expect(settings.legacyRuleEnabled).toBe(true);
    expect(settings.legacySpacesRemaining).toBeGreaterThan(0);

    await expect(
      asAdmin(`public.admin_set_tariff_settings('soty_admin', 'Admin@Soty.test', false)`)
    ).rejects.toThrow(/LEGACY_SPACES_REMAIN/);
    await expect(
      asAdmin(`public.admin_set_tariff_settings('bad name!', null, true)`)
    ).rejects.toThrow(/INVALID_INPUT/);
    await expect(
      asAdmin(`public.admin_set_tariff_settings(null, 'not-an-email', true)`)
    ).rejects.toThrow(/INVALID_INPUT/);

    const off = await asAdmin<{ telegram: string; email: string; legacyRuleEnabled: boolean }>(
      `public.admin_set_tariff_settings('@soty_admin', 'Admin@Soty.test', false, true)`
    );
    expect(off).toMatchObject({
      telegram: 'soty_admin',
      email: 'admin@soty.test',
      legacyRuleEnabled: false
    });
    expect(await allowed(team)).toBe(false);
    const history = await asAdmin<Array<{ kind: string; after: { legacyRuleEnabled: boolean } }>>(
      'public.admin_list_space_tariff_events(null)'
    );
    expect(history[0]).toMatchObject({ kind: 'settings', after: { legacyRuleEnabled: false } });
    expect((await access(owner.id)).showcase.contact).toEqual({
      telegram: 'soty_admin',
      email: 'admin@soty.test'
    });

    await asAdmin(`public.admin_set_tariff_settings('soty_admin', 'admin@soty.test', true)`);
    expect(await allowed(team)).toBe(true);
  });

  it('records requests from the showcase and lets the admin handle them', async () => {
    const someone = await person('request');
    await harness.asUser(
      someone.id,
      `select public.join_team_workspace_waitlist('lead', 'telegram')`
    );
    // The released web's zero-argument call still resolves.
    await harness.asUser(someone.id, 'select public.join_team_workspace_waitlist()');
    await expect(
      harness.asUser(someone.id, `select public.join_team_workspace_waitlist('gold', null)`)
    ).rejects.toThrow(/INVALID_INPUT/);
    const view = await access(someone.id);
    expect(view.mode).toBe('showcase');
    expect(view.showcase.request).toMatchObject({ planInterest: 'lead', channel: 'telegram' });
    expect(view.showcase.plans.map(plan => plan.code)).toEqual(['solo', 'lead']);
    expect(view.showcase.email).toBe(someone.email);

    const requests = await asAdmin<
      Array<{ userId: string; planInterest: string; hasTariff: boolean; handledAt: string | null }>
    >('public.admin_list_space_requests()');
    expect(requests.find(entry => entry.userId === someone.id)).toMatchObject({
      planInterest: 'lead',
      hasTariff: false,
      handledAt: null
    });
    expect(
      await asAdmin(`public.admin_mark_space_request($1, true, 'wrote back')`, [someone.id])
    ).toBe(true);
    const handled = await asAdmin<
      Array<{ userId: string; handledAt: string | null; adminNote: string }>
    >('public.admin_list_space_requests()');
    expect(handled.find(entry => entry.userId === someone.id)).toMatchObject({
      adminNote: 'wrote back',
      handledAt: expect.any(String)
    });
  });
});

describe('what the web sees (R10)', () => {
  it('shows the owner a banner and, once, a toast for an announced renewal', async () => {
    const owner = await person('banner');
    const member = await person('banner-member');
    const { team, tariff } = await tariffSpace(owner, 'lead', 2);
    await addMember(team, member.id);
    const view = await access(owner.id);
    expect(view.banner).toMatchObject({ teamId: team, kind: 'warn_3d', daysLeft: 2 });
    expect((await access(member.id)).banner).toBeNull();

    await setTariff(tariff, 'ends_on = $2::date', [await day(1)]);
    expect((await access(owner.id)).banner?.kind).toBe('warn_1d');
    await setTariff(tariff, 'ends_on = $2::date', [await day(-1)]);
    expect((await access(owner.id)).banner).toMatchObject({
      kind: 'grace',
      graceUntil: await day(2)
    });

    const extended = await asAdmin<Row>('public.admin_extend_space_tariff($1, 1, true)', [tariff]);
    expect((await access(owner.id)).banner).toBeNull();
    const toast = (await access(owner.id)).toast;
    expect(toast).toMatchObject({
      kind: 'renewed',
      eventId: extended.eventId,
      endsOn: extended.endsOn
    });
    expect(
      (
        await harness.asUser<{ ok: boolean }>(
          owner.id,
          'select public.ack_space_tariff_toast($1) as ok',
          [extended.eventId]
        )
      )[0]!.ok
    ).toBe(true);
    expect((await access(owner.id)).toast).toBeNull();
  });

  it('lets a member of a suspended space remind the owner once a day', async () => {
    const owner = await person('nudge');
    const member = await person('nudge-member');
    const { team, tariff } = await tariffSpace(owner);
    await addMember(team, member.id);
    await expect(
      harness.asUser(member.id, 'select public.request_space_owner_nudge($1)', [team])
    ).rejects.toThrow(/INVALID_INPUT/);
    await setTariff(tariff, 'revoked_at = now()');
    const first = (
      await harness.asUser<{ r: { sent: boolean; nextAllowedAt: string } }>(
        member.id,
        'select public.request_space_owner_nudge($1) as r',
        [team]
      )
    )[0]!.r;
    expect(first.sent).toBe(true);
    const second = (
      await harness.asUser<{ r: { sent: boolean; nextAllowedAt: string } }>(
        member.id,
        'select public.request_space_owner_nudge($1) as r',
        [team]
      )
    )[0]!.r;
    expect(second).toEqual({ sent: false, nextAllowedAt: first.nextAllowedAt });
    await expect(
      harness.asUser(owner.id, 'select public.request_space_owner_nudge($1)', [team])
    ).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('background work (R6–R8)', () => {
  it('pauses the updater of a closed space, skips its claims, and resumes without a browser', async () => {
    const owner = await person('updater');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(owner.id, `select public.set_team_catalog_update_interval($1, $2, '1d')`, [
      team,
      [sheet]
    ]);

    const choicesBefore = await harness.root(
      'select event_id from private.catalog_settings_journal where catalog_material_id=$1 order by observed_at,event_id',
      [sheet]
    );
    await asAdmin('public.admin_end_space_tariff($1, true)', [tariff]);
    expect(
      await harness.root(
        'select event_id from private.catalog_settings_journal where catalog_material_id=$1 order by observed_at,event_id',
        [sheet]
      )
    ).toEqual(choicesBefore);
    const item = await harness.root<{
      update_interval: string | null;
      paused_interval: string | null;
    }>(
      'select update_interval, paused_interval from public.team_catalog_updater_items where catalog_material_id = $1',
      [sheet]
    );
    expect(item[0]).toEqual({ update_interval: null, paused_interval: '1d' });
    const updater = await harness.root<{ state: string; paused_by_tariff_at: string | null }>(
      'select state, paused_by_tariff_at from public.team_catalog_updaters where team_id = $1',
      [team]
    );
    expect(updater[0]!.state).toBe('stopped');
    expect(updater[0]!.paused_by_tariff_at).not.toBeNull();

    // Even a due round left behind is not opened or claimed while closed.
    await harness.root(
      `update public.team_catalog_updater_items
          set round_due_at = now() - interval '1 hour'
        where catalog_material_id = $1`,
      [sheet]
    );
    await harness.root('select public.service_open_catalog_updater_rounds()');
    const opened = await harness.root<{ round_due_at: string | null }>(
      'select round_due_at from public.team_catalog_updater_items where catalog_material_id = $1',
      [sheet]
    );
    expect(opened[0]!.round_due_at).not.toBeNull();
    await harness.root(
      `update public.team_catalog_updater_items set round_due_at = now(), next_attempt_at = now()
       where catalog_material_id = $1`,
      [sheet]
    );
    const claimed = await harness.root(
      `select * from public.service_claim_catalog_updater_items('w', 10, 60) where team_id = $1`,
      [team]
    );
    expect(claimed).toHaveLength(0);
    expect(await harness.root('select private.apply_tariff_pauses(null) as n')).toEqual([{ n: 1 }]);

    // Reopened: one reconciliation and automatic recurring schedule restore.
    await asAdmin('public.admin_undo_space_tariff_event($1)', [
      (
        await asAdmin<Array<{ id: string }>>('public.admin_list_space_tariff_events($1)', [tariff])
      )[0]!.id
    ]);
    const jobs = await harness.root<{ n: number }>(
      `select count(*)::int as n from private.catalog_sync_jobs
       where connection_id = $1 and job_kind in ('initial', 'reconcile') and state = 'pending'`,
      [connection]
    );
    expect(jobs[0]!.n).toBe(1);
    const tariffView = (
      await harness.asUser<{ r: { updaterPausedByTariff: boolean } }>(
        owner.id,
        'select public.get_team_tariff($1) as r',
        [team]
      )
    )[0]!.r;
    expect(tariffView.updaterPausedByTariff).toBe(false);

    expect(
      await harness.asUser(owner.id, 'select public.resume_team_catalog_updater($1) as ok', [team])
    ).toEqual([{ ok: true }]);
    const resumed = await harness.root<{
      update_interval: string;
      paused_interval: string | null;
      due: boolean;
    }>(
      `select update_interval, paused_interval, next_run_at <= now() as due
       from public.team_catalog_updater_items where catalog_material_id = $1`,
      [sheet]
    );
    expect(resumed[0]).toEqual({ update_interval: '1d', paused_interval: null, due: true });
    const mark = await harness.root<{ paused_by_tariff_at: string | null; state: string }>(
      'select paused_by_tariff_at, state from public.team_catalog_updaters where team_id = $1',
      [team]
    );
    expect(mark[0]).toEqual({ paused_by_tariff_at: null, state: 'running' });
    expect(
      await harness.root(
        'select event_id from private.catalog_settings_journal where catalog_material_id=$1 order by observed_at,event_id',
        [sheet]
      )
    ).toEqual(choicesBefore);
  });

  it('captures expiry before the pause cron and renews only recurring enabled catalogs', async () => {
    const owner = await person('expiry-recovery');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const daily = await catalog(team, connection, owner.id);
    const weekly = await catalog(team, connection, owner.id);
    const disabled = await catalog(team, connection, owner.id);
    for (const [id, cadence] of [
      [daily, '1d'],
      [weekly, '1w'],
      [disabled, '1h']
    ]) {
      await harness.asUser(owner.id, 'select public.set_team_catalog_update_interval($1,$2,$3)', [
        team,
        [id],
        cadence
      ]);
    }
    await harness.asUser(owner.id, 'select public.set_team_catalog_update_interval($1,$2,null)', [
      team,
      [disabled]
    ]);
    const schedule = { timeZone: 'Europe/Kyiv', weekday: 7, time: '09:30' };
    await harness.root(
      'update public.team_catalog_update_profiles set schedule=$2::jsonb where catalog_material_id=$1',
      [weekly, JSON.stringify(schedule)]
    );
    const profiles = await harness.root(
      'select catalog_material_id,version,schedule,restitch from public.team_catalog_update_profiles where team_id=$1 order by catalog_material_id',
      [team]
    );
    // Root-only fixture clock: no admin transition/pause sweep has run yet.
    await setTariff(tariff, 'ends_on = private.kyiv_today() - 10');
    expect(await allowed(team)).toBe(false);
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    const restored = await harness.root<{
      catalog_material_id: string;
      update_interval: string;
      paused_interval: null;
      due: boolean;
    }>(
      `select catalog_material_id,update_interval,paused_interval,next_run_at <= clock_timestamp() as due
       from public.team_catalog_updater_items where team_id=$1 order by catalog_material_id`,
      [team]
    );
    expect(restored).toHaveLength(2);
    expect(restored.find(row => row.catalog_material_id === daily)).toMatchObject({
      update_interval: '1d',
      paused_interval: null,
      due: true
    });
    expect(restored.find(row => row.catalog_material_id === weekly)).toMatchObject({
      update_interval: '1w',
      paused_interval: null,
      due: true
    });
    expect(
      await harness.root(
        'select catalog_material_id,version,schedule,restitch from public.team_catalog_update_profiles where team_id=$1 order by catalog_material_id',
        [team]
      )
    ).toEqual(profiles);
    await harness.root('select public.service_open_catalog_updater_rounds()');
    const first = await harness.root(
      'select catalog_material_id,round_due_at,next_run_at from public.team_catalog_updater_items where team_id=$1 order by catalog_material_id',
      [team]
    );
    expect(first.every(row => row.round_due_at !== null)).toBe(true);
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    await harness.asUser(owner.id, 'select public.resume_team_catalog_updater($1)', [team]);
    await harness.root('select public.service_open_catalog_updater_rounds()');
    expect(
      await harness.root(
        'select catalog_material_id,round_due_at,next_run_at from public.team_catalog_updater_items where team_id=$1 order by catalog_material_id',
        [team]
      )
    ).toEqual(first);
    const calendar = await harness.root<{ civil: string }>(
      "select to_char(next_run_at at time zone 'Europe/Kyiv','ID HH24:MI') as civil from public.team_catalog_updater_items where catalog_material_id=$1",
      [weekly]
    );
    expect(calendar[0]!.civil).toBe('7 09:30');
  });

  it('does not let a late pause sweep stop a renewed tariff or resurrect a later manual stop', async () => {
    const owner = await person('late-pause');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(owner.id, "select public.set_team_catalog_update_interval($1,$2,'1d')", [
      team,
      [sheet]
    ]);
    await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    expect(await harness.root('select private.apply_tariff_pauses($1) as n', [team])).toEqual([
      { n: 0 }
    ]);
    await harness.asUser(owner.id, 'select public.stop_team_catalog_updater($1)', [team]);
    await harness.asUser(owner.id, 'select public.resume_team_catalog_updater($1)', [team]);
    expect(
      await harness.root(
        'select catalog_material_id from public.team_catalog_updater_items where team_id=$1',
        [team]
      )
    ).toEqual([]);
  });

  it('keeps a one-off attempt durable through pause and resumes the same round without a schedule', async () => {
    const owner = await person('oneoff-durable');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(owner.id, 'select public.run_team_catalog_update_now($1,$2)', [
      team,
      [sheet]
    ]);
    const before = await harness.root(
      'select attempt_id,round_due_at,result from public.team_catalog_update_attempts where catalog_material_id=$1',
      [sheet]
    );
    await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
    expect(
      await harness.root(
        'select attempt_id,round_due_at,result from public.team_catalog_update_attempts where catalog_material_id=$1',
        [sheet]
      )
    ).toEqual(before);
    const snapshot = await harness.root(
      'select id,resource_id,kind,round_due_at from private.workspace_pause_items where team_id=$1 order by id',
      [team]
    );
    expect(snapshot.some(row => row.kind === 'catalog_round' && row.resource_id === sheet)).toBe(
      true
    );
    await harness.root('select private.apply_tariff_pauses($1)', [team]);
    expect(
      await harness.root(
        'select id,resource_id,kind,round_due_at from private.workspace_pause_items where team_id=$1 order by id',
        [team]
      )
    ).toEqual(snapshot);
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    expect(
      await harness.root(
        'select attempt_id,round_due_at,result from public.team_catalog_update_attempts where catalog_material_id=$1',
        [sheet]
      )
    ).toEqual(before);
    const current = await harness.root(
      'select update_interval,round_due_at,tariff_pause_id from public.team_catalog_updater_items where catalog_material_id=$1',
      [sheet]
    );
    expect(current[0]).toMatchObject({
      update_interval: null,
      round_due_at: before[0]!.round_due_at,
      tariff_pause_id: null
    });
    const recoveryItem = () =>
      harness.root(
        "select item.state,item.stage,item.delivered_at from private.workspace_recovery_items item join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id where item.team_id=$1 and snapshot.kind='catalog_round'",
        [team]
      );
    expect((await recoveryItem())[0]).toMatchObject({
      state: 'leased',
      stage: 'queued',
      delivered_at: null
    });
    await harness.root(
      "update public.team_catalog_updater_items set lease_owner=$2,lease_expires_at=clock_timestamp()+interval '2 minutes' where catalog_material_id=$1",
      [sheet, owner.id]
    );
    expect((await recoveryItem())[0]).toMatchObject({ state: 'leased', stage: 'claimed' });
    await harness.root(
      `update public.team_catalog_update_attempts set stage_history='["synthetic-start"]'::jsonb where catalog_material_id=$1`,
      [sheet]
    );
    expect((await recoveryItem())[0]).toMatchObject({ state: 'resumed', stage: 'started' });
    await harness.root(
      "update public.team_catalog_update_attempts set result='success',ended_at=clock_timestamp() where catalog_material_id=$1",
      [sheet]
    );
    expect((await recoveryItem())[0]).toMatchObject({
      state: 'completed',
      stage: 'terminal',
      delivered_at: null
    });
    await harness.root('create role recovery_diagnosis_reader nologin');
    await harness.root(
      'grant select on public.analytics_workspace_recovery to recovery_diagnosis_reader'
    );
    setQueryExecutor((sql, params) =>
      harness.db.transaction(async tx => {
        await tx.exec('set local role recovery_diagnosis_reader');
        return (await tx.query<Record<string, unknown>>(sql, params)).rows;
      })
    );
    try {
      const evidence = await getRecoveryEvidence(
        team,
        null,
        new Date(Date.now() + 1000).toISOString()
      );
      expect(evidence.supported).toBe(true);
      expect(
        evidence.items.some(
          item =>
            item.kind === 'catalog_round' &&
            item.state === 'completed' &&
            item.delivery === 'unknown'
        )
      ).toBe(true);
      expect(evidence.blind_spots.some(gap => gap.includes('not proof'))).toBe(true);
    } finally {
      setQueryExecutor(null);
    }
    const eventCount = () =>
      harness.root('select count(*)::int n from public.team_catalog_events where team_id=$1', [
        team
      ]);
    const unchanged = await eventCount();
    await harness.root('select private.refresh_workspace_recovery($1)', [team]);
    await harness.root('select private.refresh_workspace_recovery($1)', [team]);
    expect(await eventCount()).toEqual(unchanged);
  });

  it('does not prepare a changed source from the tariff pause snapshot', async () => {
    const owner = await person('changed-restitch');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.root(
      "update public.team_materials set drive_version='source-1' where id=(select companion_of from public.team_materials where id=$1)",
      [sheet]
    );
    await harness.root(
      'update public.team_catalog_update_profiles set restitch=true where catalog_material_id=$1',
      [sheet]
    );
    await harness.asUser(owner.id, "select public.set_team_catalog_update_interval($1,$2,'1w')", [
      team,
      [sheet]
    ]);
    await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
    await harness.root(
      "update public.team_materials set drive_version='source-2' where id=(select companion_of from public.team_materials where id=$1)",
      [sheet]
    );
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    await harness.root('select private.observe_workspace_dependencies($1)', [team]);
    expect(
      (
        await harness.root(
          "select item.state,item.reason_code from private.workspace_recovery_items item join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id where item.team_id=$1 and snapshot.kind='restitch'",
          [team]
        )
      )[0]
    ).toEqual({ state: 'blocked', reason_code: 'source_changed' });
    expect(
      (
        await harness.root<{ r: unknown }>(
          "select public.service_claim_restitch_job($1,$2,decode(repeat('aa',32),'hex'),120) r",
          [team, owner.id]
        )
      )[0]!.r
    ).toBeNull();
  });

  it.each([
    { operationState: 'canceled', state: 'skipped_manual', reason: 'user_cancelled' },
    { operationState: 'failed', state: 'blocked', reason: 'unknown' }
  ])(
    'does not replay $operationState restitch after renewal but allows a new explicit manual round',
    async ({ operationState, state, reason }) => {
      const owner = await person('cancelled-restitch');
      const { team, tariff } = await tariffSpace(owner);
      const connection = await connect(team);
      const sheet = await catalog(team, connection, owner.id);
      await harness.root(
        'update public.team_catalog_update_profiles set restitch=true where catalog_material_id=$1',
        [sheet]
      );
      await harness.asUser(owner.id, "select public.set_team_catalog_update_interval($1,$2,'1w')", [
        team,
        [sheet]
      ]);
      const operation = (
        await harness.root<{ id: string }>(
          "insert into public.team_operations(team_id,actor_id,kind,state,source_material_id,idempotency_key,request_nonce,finished_at) values($1,$2,'process',$4,(select companion_of from public.team_materials where id=$3),gen_random_uuid()::text,gen_random_uuid()::text,clock_timestamp()) returning id",
          [team, owner.id, sheet, operationState]
        )
      )[0]!.id;
      await harness.root(
        'update private.catalog_restitch_jobs set operation_id=$2 where catalog_material_id=$1',
        [sheet, operation]
      );
      await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
      await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
      const claim = () =>
        harness.root<{ r: unknown }>(
          "select public.service_claim_restitch_job($1,$2,decode(repeat('aa',32),'hex'),120) r",
          [team, owner.id]
        );
      expect((await claim())[0]!.r).toBeNull();
      await harness.root('select private.observe_workspace_dependencies($1)', [team]);
      expect(
        (
          await harness.root(
            "select item.state,item.reason_code from private.workspace_recovery_items item join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id where item.team_id=$1 and snapshot.kind='restitch'",
            [team]
          )
        )[0]
      ).toEqual({ state, reason_code: reason });
      await harness.asUser(owner.id, 'select public.run_team_catalog_update_now($1,$2)', [
        team,
        [sheet]
      ]);
      expect((await claim())[0]!.r).not.toBeNull();
    }
  );

  it('keeps Drive-blocked recovery pending and continues once the dependency returns', async () => {
    const owner = await person('drive-recovery');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(owner.id, "select public.set_team_catalog_update_interval($1,$2,'1w')", [
      team,
      [sheet]
    ]);
    await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
    await harness.root(
      "update public.team_drive_connections set state='needs_reauth' where id=$1",
      [connection]
    );
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    expect(
      await harness.root(
        'select state,reason_code from public.analytics_workspace_recovery where team_id=$1 and kind=$2',
        [team, 'catalog_schedule']
      )
    ).toEqual([{ state: 'waiting_dependency', reason_code: 'waiting_drive' }]);
    await harness.root("update public.team_drive_connections set state='connected' where id=$1", [
      connection
    ]);
    await harness.root(
      'update private.workspace_recovery_items set next_attempt_at=now() where team_id=$1',
      [team]
    );
    await harness.root('select private.sweep_workspace_recovery()');
    expect(
      (
        await harness.root(
          'select update_interval,paused_interval from public.team_catalog_updater_items where catalog_material_id=$1',
          [sheet]
        )
      )[0]
    ).toEqual({ update_interval: '1w', paused_interval: null });
    expect(
      (
        await harness.root(
          'select state,stage from public.analytics_workspace_recovery where team_id=$1 and kind=$2',
          [team, 'catalog_schedule']
        )
      )[0]
    ).toEqual({ state: 'leased', stage: 'queued' });
  });

  it('never restores the old permissions of a removed one-off author', async () => {
    const owner = await person('rights-recovery');
    const member = await person('removed-author');
    const { team, tariff } = await tariffSpace(owner);
    await addMember(team, member.id);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(member.id, 'select public.run_team_catalog_update_now($1,$2)', [
      team,
      [sheet]
    ]);
    await asAdmin('public.admin_end_space_tariff($1,true)', [tariff]);
    await harness.root(
      "update public.team_members set status='removed',removed_at=now() where team_id=$1 and user_id=$2",
      [team, member.id]
    );
    await asAdmin('public.admin_extend_space_tariff($1,1,false)', [tariff]);
    expect(
      (
        await harness.root(
          'select state,reason_code from public.analytics_workspace_recovery where team_id=$1 and kind=$2',
          [team, 'catalog_round']
        )
      )[0]
    ).toEqual({ state: 'blocked', reason_code: 'permission_revoked' });
    expect(
      (
        await harness.root(
          'select round_due_at from public.team_catalog_updater_items where catalog_material_id=$1',
          [sheet]
        )
      )[0]!.round_due_at
    ).toBeNull();
    const outsider = await person('recovery-outsider');
    expect(
      (
        await harness.asUser<{ r: unknown }>(
          outsider.id,
          'select private.workspace_recovery_json($1,$2) as r',
          [team, outsider.id]
        )
      )[0]!.r
    ).toBeNull();
  });

  it('ends a catalog’s pause when someone schedules it again', async () => {
    const owner = await person('reschedule');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    const sheet = await catalog(team, connection, owner.id);
    await harness.asUser(owner.id, `select public.set_team_catalog_update_interval($1, $2, '1h')`, [
      team,
      [sheet]
    ]);
    await setTariff(tariff, 'revoked_at = now()');
    await harness.root('select private.apply_tariff_pauses($1)', [team]);
    await setTariff(tariff, 'revoked_at = null');
    await harness.asUser(owner.id, `select public.set_team_catalog_update_interval($1, $2, '1w')`, [
      team,
      [sheet]
    ]);
    const item = await harness.root<{ update_interval: string; paused_interval: string | null }>(
      'select update_interval, paused_interval from public.team_catalog_updater_items where catalog_material_id = $1',
      [sheet]
    );
    expect(item[0]).toEqual({ update_interval: '1w', paused_interval: null });
    const updater = await harness.root<{ paused_by_tariff_at: string | null }>(
      'select paused_by_tariff_at from public.team_catalog_updaters where team_id = $1',
      [team]
    );
    expect(updater[0]!.paused_by_tariff_at).toBeNull();
  });

  it('skips closed spaces in the sync, preview, archive and copy-deletion claims', async () => {
    const owner = await person('claims');
    const { team, tariff } = await tariffSpace(owner);
    const connection = await connect(team);
    await harness.root('select public.service_enqueue_catalog_reconciliation($1)', [connection]);
    const preview = await material(team, connection, 'pic.png', 'image', 'image/png');
    await harness.root(
      `update public.team_materials set provider_thumbnail_state = 'pending' where id = $1`,
      [preview]
    );
    const archive = await material(team, connection, 'pack.zip', 'archive', 'application/zip');
    await harness.root(`update public.team_materials set size_bytes = 1000 where id = $1`, [
      archive
    ]);
    const copy = await material(team, connection, 'copy.mp4', 'video', 'video/mp4');
    await harness.root(
      `insert into public.team_catalog_restitch_copies
         (material_id, catalog_material_id, team_id, role, drive_file_id, retired_at, next_delete_at)
       select id, null, team_id, 'retired', drive_file_id, now(), now() - interval '1 minute'
       from public.team_materials where id = $1`,
      [copy]
    );

    // Other cases in this suite deliberately leave reconciliation jobs queued.
    // Isolate this claim-budget scenario without changing the production limit.
    await harness.root(
      "update private.catalog_sync_jobs set state='canceled',lease_expires_at=null where connection_id <> $1 and state in ('pending','retry','leased')",
      [connection]
    );
    const claims = async () => ({
      sync: (
        await harness.root<{ connection_id: string }>(
          `select connection_id from private.claim_catalog_sync_jobs('w', 5, 60)`
        )
      ).filter(row => row.connection_id === connection).length,
      preview: (
        await harness.root<{ team_id: string }>(
          'select team_id from public.service_claim_preview_warm(200)'
        )
      ).filter(row => row.team_id === team).length,
      archive: (
        await harness.root<{ team_id: string }>(
          'select team_id from public.service_claim_archive_inspections(100)'
        )
      ).filter(row => row.team_id === team).length,
      copies: (
        await harness.root<{ team_id: string }>(
          'select team_id from public.service_claim_retired_restitch_copies(50)'
        )
      ).filter(row => row.team_id === team).length
    });

    await setTariff(tariff, 'revoked_at = now()');
    expect(await claims()).toEqual({ sync: 0, preview: 0, archive: 0, copies: 0 });
    const copyRow = await harness.root<{ role: string }>(
      'select role from public.team_catalog_restitch_copies where material_id = $1',
      [copy]
    );
    expect(copyRow[0]!.role).toBe('retired'); // kept, not deleted

    await setTariff(tariff, 'revoked_at = null');
    const open = await claims();
    expect(open.sync).toBeGreaterThan(0);
    expect(open.preview).toBeGreaterThan(0);
    expect(open).toMatchObject({ archive: 1, copies: 1 });
  });
});

describe('letters (R9)', () => {
  interface Notice {
    kind: string;
    period_end: string;
    state: string;
  }
  const notices = (tariff: string) =>
    harness.root<Notice>(
      `select kind, period_end::text as period_end, state from public.space_tariff_notices
       where tariff_id = $1 order by created_at, kind`,
      [tariff]
    );
  const queue = (at: string) =>
    harness.root('select private.queue_tariff_notices($1::timestamptz)', [at]);
  const claim = async () =>
    (
      await harness.root<{ r: Array<Record<string, unknown>> }>(
        'select public.service_claim_tariff_notices(50) as r'
      )
    )[0]!.r;
  const finish = async (id: unknown, sent: boolean, skipped = false) =>
    (
      await harness.root<{ ok: boolean }>(
        `select public.service_finish_tariff_notice($1, $2, 'boom', $3) as ok`,
        [id, sent, skipped]
      )
    )[0]!.ok;

  /** A space whose tariff ends on a fixed date, so `p_at` drives the queue. */
  async function fixedSpace(label: string, endsOn: string) {
    const owner = await person(label);
    const { team, tariff } = await tariffSpace(owner);
    await setTariff(tariff, 'ends_on = $2::date', [endsOn]);
    return { owner, team, tariff };
  }

  it('queues the current warning once, at the right time', async () => {
    const { tariff } = await fixedSpace('queue', '2030-03-14');
    await queue('2030-03-09T10:00:00Z'); // 5 days left
    expect(await notices(tariff)).toEqual([]);
    await queue('2030-03-11T10:00:00Z'); // 3 days
    await queue('2030-03-11T12:00:00Z');
    expect(await notices(tariff)).toEqual([
      { kind: 'warn_3d', period_end: '2030-03-14', state: 'pending' }
    ]);
  });

  it('sends only the latest letter when the queue runs late, and supersedes on extension', async () => {
    const { tariff } = await fixedSpace('late', '2030-03-14');
    await queue('2030-03-11T10:00:00Z');
    await queue('2030-03-13T10:00:00Z'); // 1 day: the 3-day letter is stale
    expect(await notices(tariff)).toEqual([
      { kind: 'warn_3d', period_end: '2030-03-14', state: 'superseded' },
      { kind: 'warn_1d', period_end: '2030-03-14', state: 'pending' }
    ]);
    await setTariff(tariff, `ends_on = '2030-04-14'`);
    await queue('2030-03-13T11:00:00Z');
    expect((await notices(tariff)).map(row => row.state)).toEqual(['superseded', 'superseded']);
  });

  it('writes the extra-days and suspension letters, and none for legacy or internal spaces', async () => {
    const { tariff } = await fixedSpace('grace', '2030-03-14');
    await queue('2030-03-15T10:00:00Z');
    await queue('2030-03-18T10:00:00Z');
    const queued = (await notices(tariff)).map(row => [row.kind, row.state]);
    expect(queued).toHaveLength(2);
    expect(queued).toEqual(
      expect.arrayContaining([
        ['grace', 'superseded'],
        ['blocked', 'pending']
      ])
    );

    const legacyOwner = await person('queue-legacy');
    const legacyTeam = await rawTeam(legacyOwner.id, 'Quiet');
    await addMember(legacyTeam, STAFF, 'admin');
    const legacyRow = await grant(legacyOwner.email, 'lead', await day(1), {
      team: legacyTeam,
      notify: true
    });
    await setTariff(legacyRow.id, `ends_on = '2030-03-14'`);
    await queue('2030-03-13T10:00:00Z');
    expect(await notices(legacyRow.id)).toEqual([]);

    const internalTeam = (
      await harness.asUser<{ id: string }>(STAFF, 'select id from public.create_team($1)', [
        'Staff space'
      ])
    )[0]!.id;
    const staffRow = await grant('staff@tariffs.test', 'lead', await day(1), {
      team: internalTeam,
      notify: true
    });
    await setTariff(staffRow.id, `ends_on = '2030-03-14'`);
    await queue('2030-03-13T10:00:00Z');
    expect(await notices(staffRow.id)).toEqual([]);
  });

  it('claims with everything the letter needs, retries failures after a lease, and fails at three', async () => {
    await harness.root(
      `update public.space_tariff_notices set state = 'skipped' where state = 'pending'`
    );
    const owner = await person('claim');
    await harness.root(`update public.profiles set language = 'en' where id = $1`, [owner.id]);
    const { team, tariff } = await tariffSpace(owner, 'lead', 2);
    await harness.root('select private.queue_tariff_notices(now())');
    const mine = async () => (await claim()).filter(row => row.tariffId === tariff);
    const first = await mine();
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      id: expect.any(String),
      kind: 'warn_3d',
      tariffId: tariff,
      teamId: team,
      teamName: expect.any(String),
      recipientEmail: owner.email,
      recipientName: expect.any(String),
      locale: 'en',
      planNameUk: 'Лід',
      planNameEn: 'Lead',
      endsOn: await day(2),
      graceUntil: await day(5),
      updaterRunning: false,
      contact: { telegram: 'soty_admin', email: 'admin@soty.test' },
      memberName: null
    });
    const id = first[0]!.id;
    expect(await mine()).toEqual([]); // leased

    expect(await finish(id, false)).toBe(true);
    expect(await mine()).toEqual([]); // waits out the lease after a failure
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await harness.root(
        `update public.space_tariff_notices set lease_until = now() - interval '1 second' where id = $1`,
        [id]
      );
      const again = await mine();
      expect(again.map(row => row.id)).toEqual([id]);
      await finish(id, false);
    }
    const final = await harness.root<{ state: string; attempts: number; last_error: string }>(
      'select state, attempts, last_error from public.space_tariff_notices where id = $1',
      [id]
    );
    expect(final[0]).toEqual({ state: 'failed', attempts: 3, last_error: 'boom' });
    expect(await finish(id, true)).toBe(false);
  });

  it('marks sent and skipped, and supersedes a letter that stopped being true', async () => {
    const owner = await person('finish');
    const member = await person('finish-member');
    const { team, tariff } = await tariffSpace(owner, 'lead', 2);
    await addMember(team, member.id);
    await harness.root('select private.queue_tariff_notices(now())');
    const warn = (await claim()).find(row => row.tariffId === tariff)!;
    expect(await finish(warn.id, true)).toBe(true);

    // Granted letter for an extension, then undone before it went out: superseded at claim.
    const extended = await asAdmin<Row>('public.admin_extend_space_tariff($1, 1, true)', [tariff]);
    await asAdmin('public.admin_undo_space_tariff_event($1)', [extended.eventId]);
    expect((await claim()).filter(row => row.tariffId === tariff)).toEqual([]);

    // A member's reminder names the member; beta skips it.
    await setTariff(tariff, 'revoked_at = now()');
    await harness.asUser(member.id, 'select public.request_space_owner_nudge($1)', [team]);
    const nudge = (await claim()).find(
      row => row.kind === 'member_nudge' && row.tariffId === tariff
    )!;
    expect(nudge.memberName).toBe(
      member.email.replace('@tariffs.test', '').replace(/-(\d+)$/, ' $1')
    );
    expect(await finish(nudge.id, false, true)).toBe(true);
    expect((await notices(tariff)).map(row => [row.kind, row.state])).toEqual([
      ['warn_3d', 'sent'],
      ['renewed', 'superseded'],
      ['member_nudge', 'skipped']
    ]);
  });

  it('queues a grant letter when asked, addressed to the email before any account exists', async () => {
    await harness.root(
      `update public.space_tariff_notices set state = 'skipped' where state = 'pending'`
    );
    const row = await grant('Future@Tariffs.test', 'solo', await day(30), { notify: true });
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      kind: 'granted',
      tariffId: row.id,
      teamId: null,
      recipientEmail: 'future@tariffs.test',
      locale: 'uk'
    });
  });
});
