import { TeamFunctionError } from './errors.ts';

/**
 * Which Google Drive access the product asks for (feature 011).
 *
 * `drive.file` is non-restricted: no verification review, no unverified-app
 * warning, no weekly token expiry. The restricted `drive` scope is added only
 * once Google has approved it for the production client, and that approval is
 * a deployment fact (`DRIVE_RESTRICTED_SCOPE_APPROVED=true`), never a code
 * default. Readiness reports both so the release gate can refuse a production
 * deployment that would put people through the unverified flow.
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_RESTRICTED_SCOPE = 'https://www.googleapis.com/auth/drive';

const RESTRICTED = new Set([
  DRIVE_RESTRICTED_SCOPE,
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
]);

export type RestrictedScopeApproval = 'approved' | 'not_approved' | 'invalid';

export function restrictedScopeApproval(value: string | undefined): RestrictedScopeApproval {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'false') return 'not_approved';
  if (normalized === 'true') return 'approved';
  return 'invalid';
}

export function isRestrictedScope(scope: string): boolean {
  return RESTRICTED.has(scope);
}

/** The scope set an authorization starts with, in a stable order. */
export function resolveDriveScopes(
  environment: Readonly<Record<string, string | undefined>>
): string[] {
  const approval = restrictedScopeApproval(environment.DRIVE_RESTRICTED_SCOPE_APPROVED);
  return approval === 'approved' ? [DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE] : [DRIVE_FILE_SCOPE];
}

/**
 * Refuse a restricted scope on the production origin without approval. Used by
 * the authorization start and by readiness; the pure form returns the code so
 * readiness can report rather than throw.
 */
export function restrictedScopeGate(
  scopes: readonly string[],
  production: boolean,
  approval: RestrictedScopeApproval
): 'RESTRICTED_SCOPE_NOT_APPROVED' | null {
  if (approval === 'invalid') return 'RESTRICTED_SCOPE_NOT_APPROVED';
  if (production && approval !== 'approved' && scopes.some(isRestrictedScope)) {
    return 'RESTRICTED_SCOPE_NOT_APPROVED';
  }
  return null;
}

export function assertScopesAllowed(
  scopes: readonly string[],
  production: boolean,
  approval: RestrictedScopeApproval
): void {
  if (restrictedScopeGate(scopes, production, approval)) {
    throw new TeamFunctionError('RESTRICTED_SCOPE_NOT_APPROVED', { retryable: false });
  }
}
