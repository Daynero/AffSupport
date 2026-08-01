export const TEAM_CONTRACT_VERSION = 1;

export const TEAM_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_BASE_ROLES = ['admin', 'editor', 'viewer'] as const;
export type TeamBaseRole = (typeof TEAM_BASE_ROLES)[number];

export const TEAM_PERMISSION_FLAGS = [
  'view',
  'download',
  'upload',
  'edit',
  'delete',
  'process',
  'manage_members',
  'manage_metadata'
] as const;
export type TeamPermissionFlag = (typeof TEAM_PERMISSION_FLAGS)[number];
export type TeamPermissions = Record<TeamPermissionFlag, boolean>;
export type TeamPermissionOverrides = Partial<TeamPermissions>;

const permissions = (...enabled: TeamPermissionFlag[]): TeamPermissions => {
  const enabledSet = new Set<TeamPermissionFlag>(enabled);
  return Object.fromEntries(
    TEAM_PERMISSION_FLAGS.map(flag => [flag, enabledSet.has(flag)])
  ) as TeamPermissions;
};

export const ROLE_PERMISSIONS: Readonly<Record<TeamRole, TeamPermissions>> = {
  owner: permissions(...TEAM_PERMISSION_FLAGS),
  admin: permissions(...TEAM_PERMISSION_FLAGS),
  editor: permissions('view', 'download', 'upload', 'edit', 'process', 'manage_metadata'),
  viewer: permissions('view', 'download')
};
export const DEFAULT_ROLE_PERMISSIONS = ROLE_PERMISSIONS;

export const TEAM_INVITATION_STATES = [
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired'
] as const;
export type TeamInvitationState = (typeof TEAM_INVITATION_STATES)[number];

export const TEAM_INVITATION_DELIVERY_STATES = ['pending', 'sent', 'failed'] as const;
export type TeamInvitationDeliveryState = (typeof TEAM_INVITATION_DELIVERY_STATES)[number];

export const TEAM_MEMBERSHIP_STATES = ['active', 'removed'] as const;
export type TeamMembershipState = (typeof TEAM_MEMBERSHIP_STATES)[number];

export const TEAM_CONNECTION_STATES = [
  'pending',
  'connected',
  'needs_reauth',
  'unavailable',
  'detached'
] as const;
export type TeamConnectionState = (typeof TEAM_CONNECTION_STATES)[number];

export const TEAM_OPERATION_STATES = [
  'pending',
  'running',
  'succeeded',
  'canceled',
  'failed'
] as const;
export type TeamOperationState = (typeof TEAM_OPERATION_STATES)[number];

export const TEAM_OPERATION_KINDS = [
  'upload',
  'download',
  'rename',
  'move',
  'trash',
  'restore',
  'content_edit',
  'new_version',
  'process'
] as const;
export type TeamOperationKind = (typeof TEAM_OPERATION_KINDS)[number];

export const TEAM_MATERIAL_LIFECYCLES = ['active', 'trashed', 'missing'] as const;
export type TeamMaterialLifecycle = (typeof TEAM_MATERIAL_LIFECYCLES)[number];

export const TRANSCRIPT_INGEST_STATES = [
  'not_applicable',
  'pending',
  'full',
  'truncated',
  'invalid_encoding',
  'unavailable'
] as const;
export type TranscriptIngestState = (typeof TRANSCRIPT_INGEST_STATES)[number];

export const DRIVE_OAUTH_MODES = ['disabled', 'testing', 'verified'] as const;
export type DriveOAuthMode = (typeof DRIVE_OAUTH_MODES)[number];

export const TEAM_INVITE_TTL_DAYS = 14;
export const TEAM_MAX_ACTIVE_MEMBERS = 50;
export const TRANSCRIPT_INDEX_MAX_BYTES = 1024 * 1024;
export const RANGE_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
export const BROWSER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const AGENT_INTAKE_MAX_BYTES = 100 * 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_MULTIPLE_BYTES = 256 * 1024;
export const OAUTH_TRANSACTION_TTL_SECONDS = 10 * 60;
export const TRANSFER_GRANT_TTL_SECONDS = 10 * 60;

const ISO_GEO_CODE_SOURCE = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`;

export const GEO_CODES = Object.freeze(ISO_GEO_CODE_SOURCE.trim().split(/\s+/));
export type GeoCode = string;

export const LANGUAGE_CODES = Object.freeze([
  'ar',
  'bg',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'kk',
  'ko',
  'lt',
  'lv',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh-Hans',
  'zh-Hant'
]);
export type LanguageCode = string;

export const TEAM_CONTRACT_SETTINGS = Object.freeze({
  teamContractVersion: TEAM_CONTRACT_VERSION,
  inviteTtlDays: TEAM_INVITE_TTL_DAYS,
  maxActiveMembers: TEAM_MAX_ACTIVE_MEMBERS,
  transcriptIndexMaxBytes: TRANSCRIPT_INDEX_MAX_BYTES,
  rangeRequestMaxBytes: RANGE_REQUEST_MAX_BYTES,
  browserDownloadMaxBytes: BROWSER_DOWNLOAD_MAX_BYTES,
  agentIntakeMaxBytes: AGENT_INTAKE_MAX_BYTES,
  uploadChunkMultipleBytes: UPLOAD_CHUNK_MULTIPLE_BYTES,
  oauthTransactionTtlSeconds: OAUTH_TRANSACTION_TTL_SECONDS,
  transferGrantTtlSeconds: TRANSFER_GRANT_TTL_SECONDS
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isTeamBaseRole(value: unknown): value is TeamBaseRole {
  return typeof value === 'string' && (TEAM_BASE_ROLES as readonly string[]).includes(value);
}

export function isTeamPermissionFlag(value: unknown): value is TeamPermissionFlag {
  return typeof value === 'string' && (TEAM_PERMISSION_FLAGS as readonly string[]).includes(value);
}

export function parseDriveOAuthMode(value: unknown): DriveOAuthMode {
  return typeof value === 'string' && (DRIVE_OAUTH_MODES as readonly string[]).includes(value)
    ? (value as DriveOAuthMode)
    : 'disabled';
}

export function resolveEffectivePermissions(
  role: TeamRole,
  overrides: unknown = undefined
): TeamPermissions {
  if (role === 'owner') return { ...ROLE_PERMISSIONS.owner };
  const resolved = { ...ROLE_PERMISSIONS[role] };
  if (!isRecord(overrides)) return resolved;
  for (const flag of TEAM_PERMISSION_FLAGS) {
    if (typeof overrides[flag] === 'boolean') resolved[flag] = overrides[flag];
  }
  return resolved;
}

export function normalizeExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/^\.+/, '');
  return /^[a-z0-9][a-z0-9._+-]{0,31}$/.test(normalized) ? normalized : null;
}

export function normalizeMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US') ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : null;
}

export function normalizeTeamName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return normalized.length >= 1 && normalized.length <= 120 ? normalized : null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().toLocaleLowerCase('en-US');
  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized
    : null;
}

export function normalizeTeamFreeText(value: unknown, maxLength = 160): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

export function normalizeTeamTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tag = normalizeTeamFreeText(raw, 64);
    if (!tag) return null;
    const key = tag.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      output.push(tag);
    }
  }
  return output;
}
