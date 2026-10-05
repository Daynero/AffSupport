import { evaluateDriveOAuthGate, type OAuthProductionSignals } from '../_shared/auth.ts';
import {
  DRIVE_FILE_SCOPE,
  DRIVE_RESTRICTED_SCOPE,
  resolveDriveScopes,
  restrictedScopeApproval,
  restrictedScopeGate
} from '../_shared/scopes.ts';
import { DRIVE_CALLBACK_PATH, driveRedirectUri } from '../_shared/google-redirect.ts';

export type TeamProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Deployment policy changed, but a token refresh cannot widen an old grant. */
export function driveScopeReconsentRequired(
  environment: TeamProviderEnvironment,
  production: boolean,
  grantedScope: string
): boolean {
  return (
    !production &&
    resolveDriveScopesForDeployment(environment, production).includes(DRIVE_RESTRICTED_SCOPE) &&
    !grantedScope.split(/\s+/).includes(DRIVE_RESTRICTED_SCOPE)
  );
}

export function resolveDriveScopesForDeployment(
  environment: TeamProviderEnvironment,
  production: boolean
): string[] {
  // The production client is verified for drive.file only. The deployment flag
  // can enable the broader scope in isolated beta, but cannot approve it in Google.
  // A separate operator opt-in enables an explicitly unverified production pilot.
  return production
    ? environment.DRIVE_UNVERIFIED_PILOT_ENABLED === 'true'
      ? [DRIVE_FILE_SCOPE, DRIVE_RESTRICTED_SCOPE]
      : [DRIVE_FILE_SCOPE]
    : resolveDriveScopes(environment);
}

export function driveDeploymentScopeGate(
  environment: TeamProviderEnvironment,
  production: boolean
): 'RESTRICTED_SCOPE_NOT_APPROVED' | null {
  const pilot = environment.DRIVE_UNVERIFIED_PILOT_ENABLED;
  const approval = restrictedScopeApproval(environment.DRIVE_RESTRICTED_SCOPE_APPROVED);
  if (
    approval === 'invalid' ||
    (pilot !== undefined && pilot !== '' && pilot !== 'false' && pilot !== 'true')
  ) {
    return 'RESTRICTED_SCOPE_NOT_APPROVED';
  }
  // Explicit operator acceptance of Google's warning/user cap is not Google approval.
  if (pilot === 'true') return null;
  return restrictedScopeGate(
    resolveDriveScopesForDeployment(environment, production),
    production,
    approval
  );
}

function configured(value: string | undefined, minimumLength = 1): boolean {
  return typeof value === 'string' && value.trim().length >= minimumLength;
}

function validRedirect(value: string | null): boolean {
  if (!configured(value ?? undefined)) return false;
  try {
    const redirect = new URL(value!);
    return (
      redirect.protocol === 'https:' &&
      (redirect.pathname.endsWith('/functions/v1/drive-oauth-callback') ||
        redirect.pathname === DRIVE_CALLBACK_PATH)
    );
  } catch {
    return false;
  }
}

export function evaluateTeamProviderReadiness(
  environment: TeamProviderEnvironment,
  signals: OAuthProductionSignals
) {
  const gate = evaluateDriveOAuthGate(environment.DRIVE_OAUTH_MODE, signals);
  // 011: the scope set is a deployment fact. A restricted scope on the
  // production origin requires Google approval or explicit unverified pilot acceptance.
  const approval = restrictedScopeApproval(environment.DRIVE_RESTRICTED_SCOPE_APPROVED);
  const scopes = resolveDriveScopesForDeployment(environment, gate.production);
  const scopeGate = driveDeploymentScopeGate(environment, gate.production);
  // The address Google returns to, as the authorization will actually send it.
  const redirectUri = driveRedirectUri(environment);
  const googleDrive =
    gate.allowed &&
    scopeGate === null &&
    configured(environment.GOOGLE_CLIENT_ID) &&
    configured(environment.GOOGLE_CLIENT_SECRET) &&
    validRedirect(redirectUri);
  const invitationEmail =
    configured(environment.RESEND_API_KEY) && configured(environment.INVITE_EMAIL_FROM);
  const directMemberAdd = environment.TEAM_DIRECT_ADD_MODE === 'testing';
  const catalogWorker = configured(environment.CATALOG_SYNC_SECRET, 32);
  const fullProviderReady = googleDrive && invitationEmail && catalogWorker;

  return {
    ready: googleDrive && (invitationEmail || directMemberAdd) && catalogWorker,
    fullProviderReady,
    production: gate.production,
    oauthMode: gate.mode,
    scopes,
    restrictedScopeApproved: approval === 'approved',
    unverifiedPilotEnabled: environment.DRIVE_UNVERIFIED_PILOT_ENABLED === 'true',
    scopeGate,
    redirectUri,
    memberOnboarding: directMemberAdd
      ? 'direct_add_testing'
      : invitationEmail
        ? 'email_invitation'
        : 'unavailable',
    services: {
      googleDrive,
      invitationEmail,
      directMemberAdd,
      catalogWorker
    }
  };
}
