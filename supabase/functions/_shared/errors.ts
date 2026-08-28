import type {
  TeamErrorCode,
  TeamStructuredError
} from '../../../packages/shared/dist/team/transport.js';

const STATUS_BY_CODE: Readonly<Record<TeamErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  NOT_A_MEMBER: 403,
  ROOT_ESCAPE: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_RESPONSE: 502,
  WRONG_STATE: 409,
  NAME_CONFLICT: 409,
  ALREADY_MEMBER: 409,
  ALREADY_INVITED: 409,
  EXPIRED: 409,
  TEAM_MEMBER_LIMIT: 409,
  OWNERSHIP_TRANSFER_REQUIRED: 409,
  // The shorter spelling the database has actually raised since 001, and the
  // one `leave_team` raises. Both are registered because the string on the wire
  // is the contract; neither can be renamed away.
  OWNER_TRANSFER_REQUIRED: 409,
  // `delete_draft_team` against a team that has ever had a drive connection:
  // the caller asked for something the team's state does not allow.
  TEAM_NOT_DRAFT: 409,
  SOURCE_CHANGED: 409,
  AGENT_REQUIRED: 409,
  AGENT_UPDATE_REQUIRED: 409,
  NO_WORK: 409,
  LEASE_EXPIRED: 409,
  LEASE_MISMATCH: 409,
  ALREADY_COMPLETED: 409,
  STALE_RESULT: 409,
  GROUP_RECONCILING: 409,
  SHARE_NOT_ALLOWED: 403,
  TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  CORRUPT_OR_PROTECTED: 422,
  RATE_LIMITED: 429,
  DRIVE_UNAVAILABLE: 503,
  NEEDS_REAUTH: 503,
  DELIVERY_UNAVAILABLE: 503,
  OAUTH_APPROVAL_REQUIRED: 503,
  // 011 — storage selections, the folder tree, thumbnail sessions, scope gate.
  SELECTION_UNREACHABLE: 400,
  ROOT_SELECTION_REQUIRED: 409,
  ROOT_MISSING: 409,
  TREE_TOO_LARGE: 413,
  THUMBNAIL_SESSION_EXPIRED: 401,
  RESTRICTED_SCOPE_NOT_APPROVED: 503
};

const RETRYABLE_CODES = new Set<TeamErrorCode>([
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'DELIVERY_UNAVAILABLE',
  'GROUP_RECONCILING'
]);

export class TeamFunctionError extends Error {
  readonly code: TeamErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: TeamErrorCode,
    options: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, string | number | boolean | null>;
    } = {}
  ) {
    super(code);
    this.name = 'TeamFunctionError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.details = sanitizeErrorDetails(options.details);
  }
}

const SENSITIVE_KEY =
  /(authorization|token|secret|grant|ticket|session|cookie|pkce|email|file|path|query|transcript|content|metadata|drive|provider)/i;
const SENSITIVE_STRING =
  /(?:\b[^@\s]+@[^@\s]+\b|https?:\/\/|(?:^|\s)[/\\]|[a-z]:\\|\/(?:Users|home|private|tmp)\/|\bbearer\s|(?:access|refresh)[_ -]?token|upload_id|session_uri|pkce|oauth|\b[\w -]+\.(?:mp4|mov|m4v|zip|txt|srt|vtt|png|jpe?g|webp)\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[A-Za-z0-9_-]{32,}\b)/i;

function isSafeDetailValue(value: string | number | boolean | null): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
  return value.length <= 64 && !SENSITIVE_STRING.test(value);
}

export function sanitizeErrorDetails(
  details: Record<string, string | number | boolean | null> | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  const safe = Object.fromEntries(
    Object.entries(details)
      .slice(0, 20)
      .filter(([key, value]) => !SENSITIVE_KEY.test(key) && isSafeDetailValue(value))
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

export function successResponse(
  value: unknown,
  headers: Record<string, string> = {},
  status = 200
): Response {
  return jsonResponse(status, { ok: true, value }, headers);
}

export function errorResponse(
  error: TeamFunctionError | TeamStructuredError,
  headers: Record<string, string> = {}
): Response {
  const normalized =
    error instanceof TeamFunctionError
      ? error
      : new TeamFunctionError(error.code, {
          retryable: error.retryable,
          details: error.details
        });
  return jsonResponse(
    normalized.status,
    {
      ok: false,
      error: {
        code: normalized.code,
        retryable: normalized.retryable,
        ...(normalized.details ? { details: normalized.details } : {})
      }
    },
    headers
  );
}

const SECRET_KEY =
  /(authorization|token|secret|grant|ticket|session|cookie|pkce|code|email|file|path|query|transcript|content|metadata|drive|provider)/i;

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(entry => redactForLog(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, entry]) => [
          key,
          SECRET_KEY.test(key) ? '[REDACTED]' : redactForLog(entry, depth + 1)
        ])
    );
  }
  if (typeof value === 'string') {
    if (SENSITIVE_STRING.test(value)) return '[REDACTED]';
    return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
  }
  return value;
}

export function mapUnknownError(error: unknown): TeamFunctionError {
  if (error instanceof TeamFunctionError) return error;
  if (error instanceof Error && error.message === 'AbortError') {
    return new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  return new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
}
