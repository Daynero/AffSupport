import { describe, expect, it } from 'vitest';
import {
  EMPTY_TEAM_TARIFF,
  TEAM_ERROR_CODES,
  normalizeTelegramLogin,
  parseAdminContact,
  parseAdminLegacySpaces,
  parseAdminOwnerSpaces,
  parseAdminSpaceRequests,
  parseAdminTariffEvents,
  parseAdminTariffPreview,
  parseAdminTariffRow,
  parseAdminTariffRows,
  parseAdminTariffSeats,
  parseAdminTariffSettings,
  parseSpaceAccess,
  parseSpaceOwnerNudge,
  parseTariffPlan,
  parseTariffPlans,
  parseTeamTariff
} from '../packages/shared/src/types';

/**
 * 034 — the web's reading of the tariff contracts (contracts.md).
 *
 * Strict where a value identifies something, forgiving where it describes it,
 * and an unknown state always reads as the one that shows nothing.
 */

const teamId = '11111111-1111-4111-8111-111111111111';

const lead = {
  code: 'lead',
  nameUk: 'Лід',
  nameEn: 'Lead',
  summaryUk: 'тімлід і люди',
  summaryEn: 'lead and people',
  baseSeats: 3,
  invitesAllowed: true,
  extraSeatsAllowed: true,
  maxExtraSeats: null,
  billingPeriod: 'month',
  highlight: true,
  features: ['explorer', 'tasks'],
  showcase: true,
  sortOrder: 20
};

const tariff = {
  state: 'expiring',
  planCode: 'lead',
  planNameUk: 'Лід',
  planNameEn: 'Lead',
  seatsTotal: 3,
  seatsUsed: 2,
  pendingInvites: 1,
  canInvite: true,
  endsOn: '2026-10-14',
  endsAt: '2026-10-14T20:59:59.999Z',
  graceUntil: '2026-10-17T20:59:59.999Z',
  daysLeft: 3,
  isOwner: true,
  updaterPausedByTariff: false
};

describe('error codes', () => {
  it('registers the six tariff codes', () => {
    expect(TEAM_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'SEATS_FULL',
        'SEATS_IN_USE',
        'SPACE_BLOCKED',
        'TARIFF_BOUND',
        'LEGACY_SPACES_REMAIN',
        'TARIFF_DATE_INVALID'
      ])
    );
  });
});

describe('catalog and contact', () => {
  it('reads a plan and fills what a sparse one leaves out', () => {
    expect(parseTariffPlan(lead)).toEqual(lead);
    expect(parseTariffPlan({ code: 'solo' })).toMatchObject({
      code: 'solo',
      nameUk: 'solo',
      nameEn: 'solo',
      baseSeats: 1,
      invitesAllowed: false,
      features: [],
      showcase: true,
      sortOrder: 0
    });
    expect(parseTariffPlan({ nameUk: 'Без коду' })).toBeNull();
    expect(parseTariffPlans([lead, { code: 'solo', sortOrder: 10 }])?.map(p => p.code)).toEqual([
      'solo',
      'lead'
    ]);
    expect(parseTariffPlans([lead, 7])).toBeNull();
  });

  it('accepts only a contact the server would have stored', () => {
    expect(parseAdminContact({ telegram: '@soty_admin', email: 'a@b.co' })).toEqual({
      telegram: 'soty_admin',
      email: 'a@b.co'
    });
    expect(parseAdminContact({ telegram: 'x', email: 'nope' })).toEqual({
      telegram: null,
      email: null
    });
    expect(parseAdminContact(null)).toEqual({ telegram: null, email: null });
    expect(normalizeTelegramLogin('bad login!')).toBeNull();
    expect(normalizeTelegramLogin('a'.repeat(33))).toBeNull();
  });
});

describe('a space tariff', () => {
  it('reads every field', () => {
    expect(parseTeamTariff(tariff)).toEqual(tariff);
  });

  it('reads an unknown state as none, and a missing field as its empty value', () => {
    expect(parseTeamTariff({ state: 'something_new' })).toEqual(EMPTY_TEAM_TARIFF);
    expect(parseTeamTariff({ ...tariff, endsOn: '14.10.2026' })?.endsOn).toBeNull();
    expect(parseTeamTariff('lead')).toBeNull();
  });
});

describe('get_my_space_access', () => {
  const access = {
    mode: 'workspace',
    canCreate: false,
    pendingTariff: null,
    teams: [
      {
        teamId,
        name: 'Команда А',
        role: 'owner',
        accessState: 'allowed',
        ownerName: 'Роман',
        tariff
      }
    ],
    invitations: [
      {
        invitationId: 'inv-1',
        teamId,
        teamName: 'Інший простір',
        inviterName: null,
        role: 'member',
        blocked: true
      }
    ],
    banner: {
      teamId,
      teamName: 'Команда А',
      kind: 'warn_3d',
      endsOn: '2026-10-14',
      graceUntil: '2026-10-17',
      daysLeft: 3,
      updaterRunning: true,
      planCode: 'lead'
    },
    toast: { teamId, kind: 'renewed', endsOn: '2026-12-12', eventId: 'evt-1' },
    showcase: {
      plans: [lead, { ...lead, code: 'hidden', showcase: false }],
      contact: { telegram: 'soty_admin', email: null },
      email: 'me@example.com',
      request: { planInterest: 'lead', channel: 'telegram', lastContactAt: '2026-10-10T10:00:00Z' }
    }
  };

  it('reads the whole reply', () => {
    const parsed = parseSpaceAccess(access);
    expect(parsed?.mode).toBe('workspace');
    expect(parsed?.teams[0]?.tariff).toEqual(tariff);
    expect(parsed?.invitations[0]?.blocked).toBe(true);
    expect(parsed?.banner?.kind).toBe('warn_3d');
    expect(parsed?.toast?.eventId).toBe('evt-1');
    // A plan that is not for the showcase never reaches it.
    expect(parsed?.showcase?.plans.map(plan => plan.code)).toEqual(['lead']);
    expect(parsed?.showcase?.request?.planInterest).toBe('lead');
  });

  it('derives a mode it does not know from what the reply lists', () => {
    expect(parseSpaceAccess({ ...access, mode: 'future' })?.mode).toBe('workspace');
    expect(
      parseSpaceAccess({
        mode: 'future',
        teams: [{ teamId, accessState: 'blocked' }]
      })?.mode
    ).toBe('blocked');
    expect(parseSpaceAccess({ mode: 'future' })?.mode).toBe('showcase');
    expect(parseSpaceAccess({ mode: 'future', canCreate: true })?.mode).toBe('workspace');
  });

  it('tolerates a sparse reply and drops malformed parts', () => {
    const parsed = parseSpaceAccess({
      mode: 'showcase',
      teams: [{ name: 'без id' }],
      invitations: 'none',
      banner: { kind: 'warn_0d', teamId, endsOn: '2026-10-14' },
      toast: { kind: 'renewed', endsOn: '2026-10-14' }
    });
    expect(parsed).toEqual({
      mode: 'showcase',
      canCreate: false,
      pendingTariff: null,
      teams: [],
      invitations: [],
      banner: null,
      toast: null,
      showcase: null
    });
    // A team whose access this build cannot read is shown as paused, never as open.
    expect(
      parseSpaceAccess({ mode: 'blocked', teams: [{ teamId, accessState: '?' }] })?.teams[0]
    ).toMatchObject({ accessState: 'blocked', tariff: EMPTY_TEAM_TARIFF });
    expect(parseSpaceAccess(null)).toBeNull();
    expect(parseSpaceAccess([])).toBeNull();
  });

  it('reads the owner nudge', () => {
    expect(parseSpaceOwnerNudge({ sent: true, nextAllowedAt: '2026-10-12T10:00:00Z' })).toEqual({
      sent: true,
      nextAllowedAt: '2026-10-12T10:00:00Z'
    });
    expect(parseSpaceOwnerNudge({ sent: false })).toEqual({ sent: false, nextAllowedAt: null });
    expect(parseSpaceOwnerNudge({})).toBeNull();
  });
});

describe('admin replies', () => {
  const row = {
    id: 'tar-1',
    ownerEmail: 'owner@example.com',
    ownerId: null,
    ownerName: null,
    teamId: null,
    teamName: null,
    planCode: 'lead',
    planNameUk: 'Лід',
    baseSeats: 3,
    extraSeats: 1,
    seatsTotal: 4,
    seatsUsed: 0,
    pendingInvites: 0,
    startsAt: '2026-10-11T10:00:00Z',
    endsOn: '2026-11-11',
    daysLeft: 31,
    graceUntil: '2026-11-14',
    revokedAt: null,
    state: 'pending',
    legacyAlso: false,
    source: 'manual',
    externalRef: null,
    note: 'оплата 10.10',
    grantedBy: 'admin-1',
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z'
  };

  it('reads a tariff row, with the undo event when extending', () => {
    expect(parseAdminTariffRow(row)).toEqual({ ...row, eventId: null });
    expect(parseAdminTariffRow({ ...row, eventId: 'evt-9' })?.eventId).toBe('evt-9');
    expect(parseAdminTariffRow({ ...row, state: 'mystery' })?.state).toBe('active');
    expect(parseAdminTariffRow({ ...row, endsOn: null })).toBeNull();
    expect(parseAdminTariffRows([row, { id: 'x' }])).toBeNull();
    expect(parseAdminTariffRows([])).toEqual([]);
  });

  it('reads the history and keeps an unknown kind as a line', () => {
    const events = parseAdminTariffEvents([
      {
        id: 'e1',
        tariffId: 'tar-1',
        actorId: 'a',
        actorName: 'Роман',
        kind: 'extended',
        before: { endsOn: '2026-11-12' },
        after: { endsOn: '2026-12-12' },
        createdAt: '2026-10-11T10:00:00Z',
        undoable: true
      },
      { id: 'e2', kind: 'renamed_later' }
    ]);
    expect(events?.map(event => event.kind)).toEqual(['extended', 'updated']);
    expect(events?.[0]?.before).toEqual({ endsOn: '2026-11-12' });
    expect(parseAdminTariffEvents('x')).toBeNull();
  });

  it('reads the preview, seats, spaces, requests and settings', () => {
    expect(
      parseAdminTariffPreview({
        accountExists: false,
        ownerName: null,
        seatsUsed: 4,
        pendingInvites: 0,
        suggestedExtraSeats: 1,
        occupants: [{ userId: 'u', name: 'A', email: 'a@x.co', role: 'owner', kind: 'member' }]
      })
    ).toMatchObject({ accountExists: false, suggestedExtraSeats: 1, occupants: [{ userId: 'u' }] });
    expect(parseAdminTariffPreview({})).toBeNull();

    expect(
      parseAdminTariffSeats([
        {
          userId: 'u',
          invitationId: null,
          name: 'A',
          email: 'a@x.co',
          role: 'owner',
          kind: 'member',
          isOwner: true,
          isAdmin: false
        },
        { userId: null, invitationId: 'i', email: 'b@x.co', role: 'member', kind: 'invitation' }
      ])?.map(seat => seat.kind)
    ).toEqual(['member', 'invitation']);
    expect(parseAdminTariffSeats([{ name: 'nobody' }])).toBeNull();

    expect(
      parseAdminOwnerSpaces([{ teamId, name: 'A', membersUsed: 2, boundTariffId: null }])
    ).toEqual([{ teamId, name: 'A', membersUsed: 2, boundTariffId: null }]);
    expect(parseAdminLegacySpaces([{ teamId, name: 'A', membersUsed: 3 }])?.[0]).toMatchObject({
      ownerEmail: null,
      membersUsed: 3
    });
    expect(
      parseAdminSpaceRequests([
        { userId: 'u', email: 'a@x.co', planInterest: 'solo', createdAt: '2026-10-01T00:00:00Z' }
      ])?.[0]
    ).toMatchObject({ planInterest: 'solo', handledAt: null, hasTariff: false });
    expect(parseAdminSpaceRequests([{ userId: 'u' }])).toBeNull();

    expect(
      parseAdminTariffSettings({
        telegram: 'soty_admin',
        email: 'admin@soty.app',
        legacyRuleEnabled: true,
        legacySpacesRemaining: 2
      })
    ).toEqual({
      telegram: 'soty_admin',
      email: 'admin@soty.app',
      legacyRuleEnabled: true,
      legacySpacesRemaining: 2
    });
    expect(parseAdminTariffSettings({ telegram: 'x' })).toBeNull();
  });
});
