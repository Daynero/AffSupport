import { evaluateDriveOAuthGate, type OAuthProductionSignals } from '../_shared/auth.ts';
import {
  resolveDriveScopes,
  restrictedScopeApproval,
  restrictedScopeGate
} from '../_shared/scopes.ts';
import { DRIVE_CALLBACK_PATH, driveRedirectUri } from '../_shared/google-redirect.ts';

export type TeamProviderEnvironment = Readonly<Record<string, string | undefined>>;

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
  // production origin without Google's approval is refused here, before any
  // person is sent through the unverified-app flow.
  const approval = restrictedScopeApproval(environment.DRIVE_RESTRICTED_SCOPE_APPROVED);
  const scopes = resolveDriveScopes(environment);
  const scopeGate = restrictedScopeGate(scopes, gate.production, approval);
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
