import { evaluateDriveOAuthGate, type OAuthProductionSignals } from '../_shared/auth.ts';

export type TeamProviderEnvironment = Readonly<Record<string, string | undefined>>;

function configured(value: string | undefined, minimumLength = 1): boolean {
  return typeof value === 'string' && value.trim().length >= minimumLength;
}

function validRedirect(value: string | undefined): boolean {
  if (!configured(value)) return false;
  try {
    const redirect = new URL(value!);
    return (
      redirect.protocol === 'https:' &&
      redirect.pathname.endsWith('/functions/v1/drive-oauth-callback')
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
  const googleDrive =
    gate.allowed &&
    configured(environment.GOOGLE_CLIENT_ID) &&
    configured(environment.GOOGLE_CLIENT_SECRET) &&
    validRedirect(environment.GOOGLE_REDIRECT_URI);
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
