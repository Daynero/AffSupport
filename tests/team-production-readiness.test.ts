import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TEAM_PRODUCTION_SECRETS,
  TEAM_INVITATION_EMAIL_SECRETS,
  missingTeamProductionSecrets,
  parseSupabaseSecretNames
} from '../scripts/lib/team-production-readiness.mjs';

describe('Team Workspace production readiness gate', () => {
  it('parses only validated Supabase secret names', () => {
    expect(
      parseSupabaseSecretNames([
        { name: 'GOOGLE_CLIENT_ID', digest: 'ignored' },
        { name: 'RESEND_API_KEY' },
        { invalid: true }
      ])
    ).toEqual(['GOOGLE_CLIENT_ID', 'RESEND_API_KEY']);
    expect(() => parseSupabaseSecretNames({ name: 'GOOGLE_CLIENT_ID' })).toThrow(
      'invalid Supabase secrets response'
    );
  });

  it('fails closed when any required production provider secret is absent', () => {
    expect(
      missingTeamProductionSecrets([
        ...REQUIRED_TEAM_PRODUCTION_SECRETS,
        ...TEAM_INVITATION_EMAIL_SECRETS
      ])
    ).toEqual([]);
    expect(
      missingTeamProductionSecrets([...REQUIRED_TEAM_PRODUCTION_SECRETS, 'TEAM_DIRECT_ADD_MODE'])
    ).toEqual([]);
    expect(missingTeamProductionSecrets(REQUIRED_TEAM_PRODUCTION_SECRETS)).toEqual([
      'RESEND_API_KEY+INVITE_EMAIL_FROM or TEAM_DIRECT_ADD_MODE'
    ]);
    expect(
      missingTeamProductionSecrets([
        ...REQUIRED_TEAM_PRODUCTION_SECRETS.filter(name => name !== 'GOOGLE_CLIENT_SECRET'),
        ...TEAM_INVITATION_EMAIL_SECRETS
      ])
    ).toEqual(['GOOGLE_CLIENT_SECRET']);
  });
});
