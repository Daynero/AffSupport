import type { TeamErrorCode } from '@video-compressor/shared';
import { TEAM_ERROR_CODES } from '@video-compressor/shared';
import type { TranslationKey } from '../i18n';
import type { UnavailableReason } from './materials/actions';

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
  UPLOAD_SESSION_UNAVAILABLE: 'teamErrorUploadSessionUnavailable',
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
  RESTRICTED_SCOPE_NOT_APPROVED: 'teamErrorRestrictedScopeNotApproved',
  RESTITCH_FORBIDDEN: 'teamRestitchForbidden',
  RESTITCH_NO_SCREENS: 'teamRestitchNoScreens',
  RESTITCH_INVALID: 'teamRestitchInvalid'
};

const KNOWN = new Set<string>(TEAM_ERROR_CODES);

const SYNC_COPY: Record<string, TranslationKey> = {
  INCOMPLETE_SCAN: 'teamErrorInvalidResponse',
  INCOMPLETE_LISTING: 'teamErrorInvalidResponse',
  RETRY_EXHAUSTED: 'teamErrorDriveUnavailable',
  CURSOR_PROVENANCE_RESET: 'teamErrorDriveUnavailable',
  SYNC_UNAVAILABLE: 'teamErrorDriveUnavailable',
  DRIVE_NOT_CONNECTED: 'teamErrorWrongState'
};

function syncErrorCopy(code: string): TranslationKey | undefined {
  return Object.entries(SYNC_COPY).find(([candidate]) => candidate === code)?.[1];
}

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
  const syncCopy = code ? syncErrorCopy(code) : undefined;
  if (syncCopy) return t(syncCopy);
  if (!code || !isTeamErrorCode(code)) return t('teamErrorUnknown');
  return t(COPY[code]);
}

/**
 * Same mapping for a thrown value, so call sites do not each re-sniff shapes.
 *
 * A code may arrive either way. The boundary attaches one as `code`; the
 * resumable uploader raises `new Error('DRIVE_UNAVAILABLE')`, putting it in
 * `message` — and reading only `code` meant every failed upload said "something
 * went wrong, try again in a moment" while the reason was right there in the
 * error. Only a registered code is read out of a message: anything else is
 * still the generic sentence, so no raw text can reach the DOM (FR-014).
 */
export function teamErrorMessageFor(error: unknown, t: (key: TranslationKey) => string): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && (isTeamErrorCode(code) || syncErrorCopy(code)))
      return teamErrorMessage(code, t);
    if (typeof code === 'string' && code in LOCAL_RUN) return t(LOCAL_RUN[code]!);
  }
  if (error instanceof Error) {
    if (isTeamErrorCode(error.message) || syncErrorCopy(error.message))
      return teamErrorMessage(error.message, t);
    if (error.message in LOCAL_RUN) return t(LOCAL_RUN[error.message]!);
  }
  return t('teamErrorUnknown');
}

/**
 * What a run on this computer says when it goes wrong (024).
 *
 * These are not the server's codes — they are raised by the local app and travel in the error's
 * message. They used to fall through to "something went wrong, try again in a moment", which for
 * a video the transcriber could not read is both wrong and useless: there is nothing to try.
 */
const LOCAL_RUN: Record<string, TranslationKey> = {
  PROCESS_FAILED: 'teamErrorProcessFailed',
  PROCESS_CANCELED: 'teamErrorProcessCanceled'
};

/**
 * Why an action that applies cannot run right now (024).
 *
 * Kept beside the error map rather than beside the menu that renders it, for
 * the same reason the error map is one place: a code becomes a sentence in one
 * file, or it becomes three slightly different sentences in three.
 *
 * These are not errors — nothing failed. They are the reason an offer is
 * standing but not takeable, and the reader is owed one.
 */
const UNAVAILABLE: Record<UnavailableReason, TranslationKey> = {
  NO_PERMISSION: 'materialReasonNoPermission',
  AGENT_REQUIRED: 'materialReasonAgentRequired',
  STORAGE_DISCONNECTED: 'materialReasonStorageDisconnected',
  CATALOG_SETTINGS_MISSING: 'materialReasonCatalogSettings',
  RESTITCH_UNCONFIGURED: 'materialReasonRestitchUnconfigured',
  NOT_READY: 'materialReasonNotReady',
  TRASHED: 'materialReasonTrashed',
  MISSING: 'materialReasonMissing'
};

export function materialUnavailableMessage(
  reason: UnavailableReason,
  t: (key: TranslationKey) => string
): string {
  return t(UNAVAILABLE[reason]);
}

/**
 * The machine code behind a thrown value, when it is one this product knows.
 *
 * Copy is one thing and control flow is another: an autosave that has to
 * behave differently for `SOURCE_CHANGED` than for a dropped connection needs
 * the code, and sniffing the shape at every call site is how three slightly
 * different sniffers appear. Nothing here reaches the DOM — that is still
 * `teamErrorMessage`'s job.
 */
export function teamErrorCodeOf(error: unknown): TeamErrorCode | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string' && isTeamErrorCode(code)) return code;
  }
  if (error instanceof Error && isTeamErrorCode(error.message)) return error.message;
  return null;
}
