import { parseWorkspaceRecovery, type WorkspaceRecovery } from './recovery.js';
import { isRecord } from './contract.js';

/**
 * Space tariffs (034): the shapes the web reads from the database, and the
 * parsers that decide whether a reply is one.
 *
 * The contract is `specs/034-space-tariffs/contracts.md`. Every parser here is
 * strict about what identifies a thing (an id, a code, a date) and forgiving
 * about what describes it: a missing optional field becomes its empty value,
 * and a state this build has never heard of becomes the one that shows nothing
 * — no banner, no badge, no warning. A newer database must never make an older
 * page claim something it cannot know.
 *
 * Dates are Kyiv days (`YYYY-MM-DD`), moments are ISO 8601. The server does
 * every calculation (FR-016); the page only formats what it is told.
 */

export const TEAM_TARIFF_STATES = [
  'internal',
  'legacy',
  'active',
  'expiring',
  'grace',
  'blocked',
  'none'
] as const;
export type TeamTariffState = (typeof TEAM_TARIFF_STATES)[number];

export const ADMIN_TARIFF_STATES = [
  'internal',
  'legacy',
  'active',
  'expiring',
  'grace',
  'blocked',
  'pending',
  'pending_expired'
] as const;
export type AdminTariffState = (typeof ADMIN_TARIFF_STATES)[number];

export const SPACE_ACCESS_MODES = ['workspace', 'blocked', 'showcase'] as const;
export type SpaceAccessMode = (typeof SPACE_ACCESS_MODES)[number];

export const TARIFF_BANNER_KINDS = ['warn_3d', 'warn_1d', 'grace'] as const;
export type TariffBannerKind = (typeof TARIFF_BANNER_KINDS)[number];

export const TARIFF_CONTACT_CHANNELS = ['telegram', 'email', 'copy'] as const;
export type TariffContactChannel = (typeof TARIFF_CONTACT_CHANNELS)[number];

export const ADMIN_TARIFF_EVENT_KINDS = [
  'granted',
  'updated',
  'extended',
  'ended_today',
  'ended_now',
  'undone',
  'member_removed',
  'invitation_revoked',
  'bound',
  'claimed',
  'owner_deleted',
  'settings'
] as const;
export type AdminTariffEventKind = (typeof ADMIN_TARIFF_EVENT_KINDS)[number];

/** Telegram logins as the server validates them (R14): 5–32 of `[A-Za-z0-9_]`. */
export const TELEGRAM_LOGIN_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;

export interface TariffPlan {
  code: string;
  nameUk: string;
  nameEn: string;
  summaryUk: string;
  summaryEn: string;
  baseSeats: number;
  invitesAllowed: boolean;
  extraSeatsAllowed: boolean;
  maxExtraSeats: number | null;
  billingPeriod: string | null;
  highlight: boolean;
  features: string[];
  showcase: boolean;
  sortOrder: number;
}

export interface AdminContact {
  /** A login without the `@`, already validated; null when absent or malformed. */
  telegram: string | null;
  email: string | null;
}

export interface TeamTariff {
  state: TeamTariffState;
  planCode: string | null;
  planNameUk: string | null;
  planNameEn: string | null;
  seatsTotal: number;
  seatsUsed: number;
  pendingInvites: number;
  canInvite: boolean;
  endsOn: string | null;
  endsAt: string | null;
  graceUntil: string | null;
  daysLeft: number | null;
  isOwner: boolean;
  updaterPausedByTariff: boolean;
  recovery?: WorkspaceRecovery | null;
}

export interface SpaceAccessTeam {
  teamId: string;
  name: string;
  role: string;
  accessState: 'allowed' | 'blocked';
  ownerName: string | null;
  tariff: TeamTariff;
}

export interface SpaceAccessInvitation {
  invitationId: string;
  teamId: string;
  teamName: string;
  inviterName: string | null;
  role: string;
  blocked: boolean;
}

export interface SpaceAccessBanner {
  teamId: string;
  teamName: string;
  kind: TariffBannerKind;
  endsOn: string;
  graceUntil: string;
  daysLeft: number;
  updaterRunning: boolean;
  planCode: string;
}

export interface SpaceAccessToast {
  teamId: string;
  kind: 'renewed' | 'granted';
  endsOn: string;
  eventId: string;
}

export interface SpaceShowcaseRequest {
  planInterest: string | null;
  channel: string | null;
  lastContactAt: string | null;
}

export interface SpaceShowcase {
  plans: TariffPlan[];
  contact: AdminContact;
  email: string;
  request: SpaceShowcaseRequest | null;
}

export interface PendingTariff {
  planCode: string;
  planNameUk: string;
  planNameEn: string;
  endsOn: string;
}

export interface SpaceAccess {
  mode: SpaceAccessMode;
  canCreate: boolean;
  pendingTariff: PendingTariff | null;
  teams: SpaceAccessTeam[];
  invitations: SpaceAccessInvitation[];
  banner: SpaceAccessBanner | null;
  toast: SpaceAccessToast | null;
  showcase: SpaceShowcase | null;
}

export interface SpaceOwnerNudgeResult {
  sent: boolean;
  nextAllowedAt: string | null;
}

export interface AdminTariffRow {
  id: string;
  ownerEmail: string;
  ownerId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  planCode: string;
  planNameUk: string;
  baseSeats: number;
  extraSeats: number;
  seatsTotal: number;
  seatsUsed: number;
  pendingInvites: number;
  startsAt: string;
  endsOn: string;
  daysLeft: number;
  graceUntil: string;
  revokedAt: string | null;
  state: AdminTariffState;
  legacyAlso: boolean;
  source: 'manual' | 'trial';
  externalRef: string | null;
  note: string | null;
  grantedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on `admin_extend_space_tariff`: the event to undo. */
  eventId: string | null;
}

export interface AdminTariffEvent {
  id: string;
  tariffId: string | null;
  actorId: string | null;
  actorName: string | null;
  /** Unknown kinds are kept as `updated` so the history still has a line for them. */
  kind: AdminTariffEventKind;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  undoable: boolean;
}

export interface AdminOwnerSpace {
  teamId: string;
  name: string;
  membersUsed: number;
  boundTariffId: string | null;
}

export interface AdminTariffOccupant {
  userId: string | null;
  name: string | null;
  email: string | null;
  role: string;
  kind: 'member' | 'invitation';
}

export interface AdminTariffPreview {
  accountExists: boolean;
  ownerName: string | null;
  seatsUsed: number;
  pendingInvites: number;
  suggestedExtraSeats: number;
  occupants: AdminTariffOccupant[];
}

export interface AdminTariffSeat {
  userId: string | null;
  invitationId: string | null;
  name: string | null;
  email: string | null;
  role: string;
  kind: 'member' | 'invitation';
  isOwner: boolean;
  isAdmin: boolean;
}

export interface AdminLegacySpace {
  teamId: string;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  membersUsed: number;
}

export interface AdminSpaceRequest {
  userId: string;
  email: string;
  name: string | null;
  planInterest: string | null;
  channel: string | null;
  createdAt: string;
  lastContactAt: string | null;
  handledAt: string | null;
  adminNote: string | null;
  hasTariff: boolean;
}

export interface AdminTariffSettings {
  telegram: string | null;
  email: string | null;
  legacyRuleEnabled: boolean;
  legacySpacesRemaining: number;
}

/* ------------------------------------------------------------------------- */
/* Field readers                                                              */
/* ------------------------------------------------------------------------- */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function day(value: unknown): string | null {
  return typeof value === 'string' && DAY_PATTERN.test(value) ? value : null;
}

function moment(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((item): item is T => item !== null);
}

/** A list that must be one: anything else, or any malformed row, rejects the reply. */
function strictList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(parse);
  return rows.every((row): row is T => row !== null) ? rows : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A login without the leading `@`, or null when it is not one the server would accept. */
export function normalizeTelegramLogin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const login = value.trim().replace(/^@/u, '');
  return TELEGRAM_LOGIN_PATTERN.test(login) ? login : null;
}

function contactEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

/* ------------------------------------------------------------------------- */
/* Parsers                                                                    */
/* ------------------------------------------------------------------------- */

export function parseTariffPlan(value: unknown): TariffPlan | null {
  const row = object(value);
  const code = requiredText(row?.code);
  if (!row || !code) return null;
  const nameUk = text(row.nameUk) ?? text(row.nameEn) ?? code;
  const nameEn = text(row.nameEn) ?? nameUk;
  return {
    code,
    nameUk,
    nameEn,
    summaryUk: text(row.summaryUk) ?? '',
    summaryEn: text(row.summaryEn) ?? text(row.summaryUk) ?? '',
    baseSeats: Math.max(1, count(row.baseSeats, 1)),
    invitesAllowed: flag(row.invitesAllowed),
    extraSeatsAllowed: flag(row.extraSeatsAllowed),
    maxExtraSeats: row.maxExtraSeats === null ? null : (integer(row.maxExtraSeats) ?? null),
    billingPeriod: text(row.billingPeriod),
    highlight: flag(row.highlight),
    features: list(row.features, item => (typeof item === 'string' ? item : null)),
    showcase: row.showcase === undefined ? true : flag(row.showcase),
    sortOrder: integer(row.sortOrder) ?? 0
  };
}

export function parseAdminContact(value: unknown): AdminContact {
  const row = object(value);
  return {
    telegram: normalizeTelegramLogin(row?.telegram),
    email: contactEmail(row?.email)
  };
}

/** The tariff that says nothing: no plan, no dates, no warnings. */
export const EMPTY_TEAM_TARIFF: TeamTariff = Object.freeze({
  state: 'none',
  planCode: null,
  planNameUk: null,
  planNameEn: null,
  seatsTotal: 0,
  seatsUsed: 0,
  pendingInvites: 0,
  canInvite: false,
  endsOn: null,
  endsAt: null,
  graceUntil: null,
  daysLeft: null,
  isOwner: false,
  updaterPausedByTariff: false
}) as TeamTariff;

export function parseTeamTariff(value: unknown): TeamTariff | null {
  const row = object(value);
  if (!row) return null;
  return {
    state: oneOf(TEAM_TARIFF_STATES, row.state) ?? 'none',
    planCode: text(row.planCode),
    planNameUk: text(row.planNameUk),
    planNameEn: text(row.planNameEn) ?? text(row.planNameUk),
    seatsTotal: count(row.seatsTotal),
    seatsUsed: count(row.seatsUsed),
    pendingInvites: count(row.pendingInvites),
    canInvite: flag(row.canInvite),
    endsOn: day(row.endsOn),
    endsAt: moment(row.endsAt),
    graceUntil: moment(row.graceUntil) ?? day(row.graceUntil),
    daysLeft: integer(row.daysLeft),
    isOwner: flag(row.isOwner),
    updaterPausedByTariff: flag(row.updaterPausedByTariff),
    ...(row.recovery !== undefined ? { recovery: parseWorkspaceRecovery(row.recovery) } : {})
  };
}

function parseAccessTeam(value: unknown): SpaceAccessTeam | null {
  const row = object(value);
  const teamId = requiredText(row?.teamId);
  if (!row || !teamId) return null;
  return {
    teamId,
    name: text(row.name) ?? '',
    role: text(row.role) ?? 'member',
    // Unknown is treated as blocked: the page then shows the paused screen,
    // and the server — which decides — opens it again on the next poll.
    accessState: row.accessState === 'allowed' ? 'allowed' : 'blocked',
    ownerName: text(row.ownerName),
    tariff: parseTeamTariff(row.tariff) ?? EMPTY_TEAM_TARIFF
  };
}

function parseAccessInvitation(value: unknown): SpaceAccessInvitation | null {
  const row = object(value);
  const invitationId = requiredText(row?.invitationId);
  if (!row || !invitationId) return null;
  return {
    invitationId,
    teamId: text(row.teamId) ?? '',
    teamName: text(row.teamName) ?? '',
    inviterName: text(row.inviterName),
    role: text(row.role) ?? 'member',
    blocked: flag(row.blocked)
  };
}

function parseBanner(value: unknown): SpaceAccessBanner | null {
  const row = object(value);
  const kind = oneOf(TARIFF_BANNER_KINDS, row?.kind);
  const teamId = requiredText(row?.teamId);
  const endsOn = day(row?.endsOn);
  if (!row || !kind || !teamId || !endsOn) return null;
  return {
    teamId,
    teamName: text(row.teamName) ?? '',
    kind,
    endsOn,
    graceUntil: day(row.graceUntil) ?? moment(row.graceUntil) ?? endsOn,
    daysLeft: integer(row.daysLeft) ?? 0,
    updaterRunning: flag(row.updaterRunning),
    planCode: text(row.planCode) ?? ''
  };
}

function parseToast(value: unknown): SpaceAccessToast | null {
  const row = object(value);
  const kind = row?.kind === 'renewed' || row?.kind === 'granted' ? row.kind : null;
  const eventId = requiredText(row?.eventId);
  const endsOn = day(row?.endsOn);
  if (!row || !kind || !eventId || !endsOn) return null;
  return { teamId: text(row.teamId) ?? '', kind, endsOn, eventId };
}

function parseShowcase(value: unknown): SpaceShowcase | null {
  const row = object(value);
  if (!row) return null;
  const request = object(row.request);
  return {
    plans: list(row.plans, parseTariffPlan)
      .filter(plan => plan.showcase)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    contact: parseAdminContact(row.contact),
    email: text(row.email) ?? '',
    request: request
      ? {
          planInterest: text(request.planInterest),
          channel: text(request.channel),
          lastContactAt: moment(request.lastContactAt)
        }
      : null
  };
}

function parsePendingTariff(value: unknown): PendingTariff | null {
  const row = object(value);
  const planCode = requiredText(row?.planCode);
  const endsOn = day(row?.endsOn);
  if (!row || !planCode || !endsOn) return null;
  const planNameUk = text(row.planNameUk) ?? planCode;
  return { planCode, planNameUk, planNameEn: text(row.planNameEn) ?? planNameUk, endsOn };
}

/**
 * `get_my_space_access`. Null only when the reply is not an object at all; a
 * reply with a mode this build does not know is read from what it lists.
 */
export function parseSpaceAccess(value: unknown): SpaceAccess | null {
  const row = object(value);
  if (!row) return null;
  const teams = list(row.teams, parseAccessTeam);
  const canCreate = flag(row.canCreate);
  const derived: SpaceAccessMode =
    canCreate || teams.some(team => team.accessState === 'allowed')
      ? 'workspace'
      : teams.length > 0
        ? 'blocked'
        : 'showcase';
  return {
    mode: oneOf(SPACE_ACCESS_MODES, row.mode) ?? derived,
    canCreate,
    pendingTariff: parsePendingTariff(row.pendingTariff),
    teams,
    invitations: list(row.invitations, parseAccessInvitation),
    banner: parseBanner(row.banner),
    toast: parseToast(row.toast),
    showcase: parseShowcase(row.showcase)
  };
}

export function parseSpaceOwnerNudge(value: unknown): SpaceOwnerNudgeResult | null {
  const row = object(value);
  if (!row || typeof row.sent !== 'boolean') return null;
  return { sent: row.sent, nextAllowedAt: moment(row.nextAllowedAt) };
}

export function parseAdminTariffRow(value: unknown): AdminTariffRow | null {
  const row = object(value);
  const id = requiredText(row?.id);
  const ownerEmail = requiredText(row?.ownerEmail);
  const planCode = requiredText(row?.planCode);
  const endsOn = day(row?.endsOn);
  if (!row || !id || !ownerEmail || !planCode || !endsOn) return null;
  const baseSeats = count(row.baseSeats, 1);
  const extraSeats = count(row.extraSeats);
  return {
    id,
    ownerEmail,
    ownerId: text(row.ownerId),
    ownerName: text(row.ownerName),
    teamId: text(row.teamId),
    teamName: text(row.teamName),
    planCode,
    planNameUk: text(row.planNameUk) ?? planCode,
    baseSeats,
    extraSeats,
    seatsTotal: count(row.seatsTotal, baseSeats + extraSeats),
    seatsUsed: count(row.seatsUsed),
    pendingInvites: count(row.pendingInvites),
    startsAt: moment(row.startsAt) ?? '',
    endsOn,
    daysLeft: integer(row.daysLeft) ?? 0,
    graceUntil: day(row.graceUntil) ?? moment(row.graceUntil) ?? endsOn,
    revokedAt: moment(row.revokedAt),
    // An admin row whose state this build does not know reads as plainly
    // active: it shows its dates and offers the ordinary actions.
    state: oneOf(ADMIN_TARIFF_STATES, row.state) ?? 'active',
    legacyAlso: flag(row.legacyAlso),
    source: row.source === 'trial' ? 'trial' : 'manual',
    externalRef: text(row.externalRef),
    note: text(row.note),
    grantedBy: text(row.grantedBy),
    createdAt: moment(row.createdAt) ?? '',
    updatedAt: moment(row.updatedAt) ?? '',
    eventId: text(row.eventId)
  };
}

export function parseAdminTariffRows(value: unknown): AdminTariffRow[] | null {
  return strictList(value, parseAdminTariffRow);
}

export function parseAdminTariffEvent(value: unknown): AdminTariffEvent | null {
  const row = object(value);
  const id = requiredText(row?.id);
  if (!row || !id) return null;
  return {
    id,
    tariffId: text(row.tariffId),
    actorId: text(row.actorId),
    actorName: text(row.actorName),
    kind: oneOf(ADMIN_TARIFF_EVENT_KINDS, row.kind) ?? 'updated',
    before: object(row.before),
    after: object(row.after),
    createdAt: moment(row.createdAt) ?? '',
    undoable: flag(row.undoable)
  };
}

export function parseAdminTariffEvents(value: unknown): AdminTariffEvent[] | null {
  return strictList(value, parseAdminTariffEvent);
}

export function parseTariffPlans(value: unknown): TariffPlan[] | null {
  const plans = strictList(value, parseTariffPlan);
  return plans ? [...plans].sort((a, b) => a.sortOrder - b.sortOrder) : null;
}

export function parseAdminOwnerSpaces(value: unknown): AdminOwnerSpace[] | null {
  return strictList(value, item => {
    const row = object(item);
    const teamId = requiredText(row?.teamId);
    if (!row || !teamId) return null;
    return {
      teamId,
      name: text(row.name) ?? '',
      membersUsed: count(row.membersUsed),
      boundTariffId: text(row.boundTariffId)
    };
  });
}

function occupantKind(value: unknown): 'member' | 'invitation' {
  return value === 'invitation' ? 'invitation' : 'member';
}

export function parseAdminTariffPreview(value: unknown): AdminTariffPreview | null {
  const row = object(value);
  if (!row || typeof row.accountExists !== 'boolean') return null;
  return {
    accountExists: row.accountExists,
    ownerName: text(row.ownerName),
    seatsUsed: count(row.seatsUsed),
    pendingInvites: count(row.pendingInvites),
    suggestedExtraSeats: count(row.suggestedExtraSeats),
    occupants: list(row.occupants, item => {
      const occupant = object(item);
      if (!occupant) return null;
      return {
        userId: text(occupant.userId),
        name: text(occupant.name),
        email: text(occupant.email),
        role: text(occupant.role) ?? 'member',
        kind: occupantKind(occupant.kind)
      };
    })
  };
}

export function parseAdminTariffSeats(value: unknown): AdminTariffSeat[] | null {
  return strictList(value, item => {
    const row = object(item);
    if (!row) return null;
    const userId = text(row.userId);
    const invitationId = text(row.invitationId);
    if (!userId && !invitationId) return null;
    return {
      userId,
      invitationId,
      name: text(row.name),
      email: text(row.email),
      role: text(row.role) ?? 'member',
      kind: invitationId && !userId ? 'invitation' : occupantKind(row.kind),
      isOwner: flag(row.isOwner),
      isAdmin: flag(row.isAdmin)
    };
  });
}

export function parseAdminLegacySpaces(value: unknown): AdminLegacySpace[] | null {
  return strictList(value, item => {
    const row = object(item);
    const teamId = requiredText(row?.teamId);
    if (!row || !teamId) return null;
    return {
      teamId,
      name: text(row.name) ?? '',
      ownerEmail: text(row.ownerEmail),
      ownerName: text(row.ownerName),
      membersUsed: count(row.membersUsed)
    };
  });
}

export function parseAdminSpaceRequests(value: unknown): AdminSpaceRequest[] | null {
  return strictList(value, item => {
    const row = object(item);
    const userId = requiredText(row?.userId);
    const email = requiredText(row?.email);
    if (!row || !userId || !email) return null;
    return {
      userId,
      email,
      name: text(row.name),
      planInterest: text(row.planInterest),
      channel: text(row.channel),
      createdAt: moment(row.createdAt) ?? '',
      lastContactAt: moment(row.lastContactAt),
      handledAt: moment(row.handledAt),
      adminNote: text(row.adminNote),
      hasTariff: flag(row.hasTariff)
    };
  });
}

export function parseAdminTariffSettings(value: unknown): AdminTariffSettings | null {
  const row = object(value);
  if (!row || typeof row.legacyRuleEnabled !== 'boolean') return null;
  return {
    telegram: normalizeTelegramLogin(row.telegram),
    email: contactEmail(row.email),
    legacyRuleEnabled: row.legacyRuleEnabled,
    legacySpacesRemaining: count(row.legacySpacesRemaining)
  };
}
