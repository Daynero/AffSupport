export const REQUIRED_TEAM_PRODUCTION_SECRETS = Object.freeze([
  'CATALOG_SYNC_SECRET',
  'DRIVE_OAUTH_MODE',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'WISHLY_SITE_URL'
]);

export const TEAM_INVITATION_EMAIL_SECRETS = Object.freeze(['RESEND_API_KEY', 'INVITE_EMAIL_FROM']);

export function parseSupabaseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error('invalid Supabase secrets response');
  return value
    .filter(entry => entry && typeof entry === 'object' && typeof entry.name === 'string')
    .map(entry => entry.name);
}

export function missingTeamProductionSecrets(secretNames) {
  const available = new Set(secretNames);
  const missing = REQUIRED_TEAM_PRODUCTION_SECRETS.filter(name => !available.has(name));
  const invitationEmail = TEAM_INVITATION_EMAIL_SECRETS.every(name => available.has(name));
  const directMemberTesting = available.has('TEAM_DIRECT_ADD_MODE');
  if (!invitationEmail && !directMemberTesting) {
    missing.push('RESEND_API_KEY+INVITE_EMAIL_FROM or TEAM_DIRECT_ADD_MODE');
  }
  return missing;
}
