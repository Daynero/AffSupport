export const REQUIRED_TEAM_PRODUCTION_SECRETS = Object.freeze([
  'CATALOG_SYNC_SECRET',
  'DRIVE_OAUTH_MODE',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'INVITE_EMAIL_FROM',
  'RESEND_API_KEY',
  'WISHLY_SITE_URL'
]);

export const REQUIRED_TEAM_MEMBER_PILOT_SECRETS = Object.freeze([
  'TEAM_DIRECT_ADD_MODE',
  'WISHLY_SITE_URL'
]);

export function parseSupabaseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error('invalid Supabase secrets response');
  return value
    .filter(entry => entry && typeof entry === 'object' && typeof entry.name === 'string')
    .map(entry => entry.name);
}

export function missingTeamProductionSecrets(secretNames, options = {}) {
  const available = new Set(secretNames);
  const required = options.memberPilot
    ? REQUIRED_TEAM_MEMBER_PILOT_SECRETS
    : REQUIRED_TEAM_PRODUCTION_SECRETS;
  return required.filter(name => !available.has(name));
}
