import type { TeamErrorCode } from '@video-compressor/shared';
import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';

/**
 * The single code→copy mapper for team mode.
 *
 * Machine codes are the API contract (constitution V) and stay stable on the
 * wire; humanization happens only here, at render. The map is a total `Record`
 * over `TeamErrorCode`, so adding a code to the shared contract without giving
 * it a sentence is a type error rather than a silent fallback in production.
 */
const COPY: Record<TeamErrorCode, TranslationKey> = {
  AUTH_REQUIRED: 'teamErrorAuthRequired',
  PERMISSION_DENIED: 'teamErrorPermissionDenied',
  NOT_A_MEMBER: 'teamErrorNotAMember',
  NOT_FOUND: 'teamErrorNotFound',
  INVALID_INPUT: 'teamErrorInvalidInput',
  INVALID_RESPONSE: 'teamErrorInvalidResponse',
  WRONG_STATE: 'teamErrorWrongState',
  NAME_CONFLICT: 'teamErrorNameConflict',
  ALREADY_MEMBER: 'teamErrorAlreadyMember',
  ALREADY_INVITED: 'teamErrorAlreadyInvited',
  EXPIRED: 'teamErrorExpired',
  TEAM_MEMBER_LIMIT: 'teamErrorMemberLimit',
  OWNERSHIP_TRANSFER_REQUIRED: 'teamErrorOwnerTransferRequired',
  OWNER_TRANSFER_REQUIRED: 'teamErrorOwnerTransferRequired',
  SOURCE_CHANGED: 'teamErrorSourceChanged',
  TOO_LARGE: 'teamErrorTooLarge',
  UNSUPPORTED_MEDIA: 'teamErrorUnsupportedMedia',
  CORRUPT_OR_PROTECTED: 'teamErrorCorruptOrProtected',
  RATE_LIMITED: 'teamErrorRateLimited',
  DRIVE_UNAVAILABLE: 'teamErrorDriveUnavailable',
  NEEDS_REAUTH: 'teamErrorNeedsReauth',
  DELIVERY_UNAVAILABLE: 'teamErrorDeliveryUnavailable',
  OAUTH_APPROVAL_REQUIRED: 'teamErrorOAuthApprovalRequired',
  ROOT_ESCAPE: 'teamErrorRootEscape',
  AGENT_REQUIRED: 'teamErrorAgentRequired',
  AGENT_UPDATE_REQUIRED: 'teamErrorAgentUpdateRequired',
  NO_WORK: 'teamErrorNoWork',
  LEASE_EXPIRED: 'teamErrorLeaseExpired',
  LEASE_MISMATCH: 'teamErrorLeaseMismatch',
  ALREADY_COMPLETED: 'teamErrorAlreadyCompleted',
  STALE_RESULT: 'teamErrorStaleResult',
  GROUP_RECONCILING: 'teamErrorGroupReconciling',
  SHARE_NOT_ALLOWED: 'teamErrorShareNotAllowed',
  TEAM_NOT_DRAFT: 'teamErrorTeamNotDraft',
  SELECTION_UNREACHABLE: 'teamErrorSelectionUnreachable',
  ROOT_SELECTION_REQUIRED: 'teamErrorRootSelectionRequired',
  ROOT_MISSING: 'teamErrorRootMissing',
  TREE_TOO_LARGE: 'teamErrorTreeTooLarge',
  THUMBNAIL_SESSION_EXPIRED: 'teamErrorThumbnailSessionExpired',
  RESTRICTED_SCOPE_NOT_APPROVED: 'teamErrorRestrictedScopeNotApproved'
};

const KNOWN = new Set<string>(TEAM_ERROR_CODES);

function isTeamErrorCode(value: string): value is TeamErrorCode {
  return KNOWN.has(value);
}

/**
 * Turn whatever came back from the boundary into a sentence.
 *
 * The parameter is a plain `string` on purpose: `throwRpc` extracts the code
 * from a Postgres error message, so at runtime it can be any uppercase token a
 * future migration raises. Anything unrecognized gets the generic fallback —
 * never the raw code, which must not reach the DOM (FR-014).
 */
export function teamErrorMessage(
  code: string | null | undefined,
  t: (key: TranslationKey) => string
): string {
  if (!code || !isTeamErrorCode(code)) return t('teamErrorUnknown');
  return t(COPY[code]);
}

/** Same mapping for a thrown value, so call sites do not each re-sniff shapes. */
export function teamErrorMessageFor(error: unknown, t: (key: TranslationKey) => string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string') return teamErrorMessage(code, t);
  }
  return t('teamErrorUnknown');
}
