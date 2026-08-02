import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TEAM_MEMBER_PILOT_SECRETS,
  REQUIRED_TEAM_PRODUCTION_SECRETS,
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
    expect(missingTeamProductionSecrets(REQUIRED_TEAM_PRODUCTION_SECRETS)).toEqual([]);
    expect(
      missingTeamProductionSecrets([
        ...REQUIRED_TEAM_PRODUCTION_SECRETS.filter(name => name !== 'GOOGLE_CLIENT_SECRET')
      ])
    ).toEqual(['GOOGLE_CLIENT_SECRET']);
  });

  it('uses a separate narrow secret gate for the explicitly labelled member pilot', () => {
    expect(
      missingTeamProductionSecrets(REQUIRED_TEAM_MEMBER_PILOT_SECRETS, { memberPilot: true })
    ).toEqual([]);
    expect(missingTeamProductionSecrets(['WISHLY_SITE_URL'], { memberPilot: true })).toEqual([
      'TEAM_DIRECT_ADD_MODE'
    ]);
  });
});
