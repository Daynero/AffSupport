import { describe, expect, it } from 'vitest';
import {
  authProblems,
  functionParity,
  migrationDrift,
  missingSecrets,
  originAgreement,
  undeclaredSecrets
} from '../scripts/lib/production-config.mjs';

/**
 * These are the judgements the release makes about a project it cannot see the
 * inside of. Each case here is a shape a real project produced, not a shape
 * invented to make a function look correct.
 */
describe('live project comparisons', () => {
  it('names the required secrets a project does not have', () => {
    expect(missingSecrets(['A', 'B', 'C'], ['B'])).toEqual(['A', 'C']);
    expect(missingSecrets(['A'], ['A', 'EXTRA'])).toEqual([]);
  });

  it('treats platform-injected secrets as belonging to the platform, not as leftovers', () => {
    // A real project carries SUPABASE_DB_URL, SUPABASE_JWKS and friends that no
    // repository declares. Reporting them as strays would train the reader to
    // ignore this list.
    expect(
      undeclaredSecrets(['RESEND_API_KEY'], ['RESEND_API_KEY', 'SUPABASE_JWKS', 'OLD_FEATURE_KEY'])
    ).toEqual(['OLD_FEATURE_KEY']);
  });

  it('separates a function that is absent from one that is merely not serving', () => {
    const parity = functionParity(
      ['drive-connect', 'preview-warm', 'library-ops'],
      [
        { slug: 'drive-connect', status: 'ACTIVE', version: 19 },
        { slug: 'preview-warm', status: 'REMOVED', version: 3 },
        { slug: 'legacy-sync', status: 'ACTIVE', version: 2 }
      ]
    );
    expect(parity.missing).toEqual(['library-ops']);
    expect(parity.inactive).toEqual(['preview-warm']);
    expect(parity.undeclared).toEqual(['legacy-sync']);
  });

  it('calls an undeclared local migration drift and a declared one the plan', () => {
    const entries = [
      { local: '20260907140000', remote: '20260907140000' },
      { local: '20260912150000', remote: '' },
      { local: '20260912160000', remote: '' }
    ];
    const blind = migrationDrift(entries);
    expect(blind.unapplied).toEqual(['20260912150000', '20260912160000']);
    expect(blind.planned).toEqual([]);

    const declared = migrationDrift(entries, ['20260912150000', '20260912160000']);
    expect(declared.unapplied).toEqual([]);
    expect(declared.planned).toEqual(['20260912150000', '20260912160000']);
  });

  it('reports a migration applied there that does not exist here', () => {
    // The database has a shape this repository cannot reproduce, which makes
    // every local rehearsal a rehearsal of a different database.
    expect(migrationDrift([{ local: '', remote: '20260101000000' }]).untracked).toEqual([
      '20260101000000'
    ]);
  });

  it('catches the sign-in round trip breaking in each of its ways', () => {
    expect(
      authProblems(
        {
          siteUrl: 'https://soty.pp.ua',
          allowList: 'http://127.0.0.1:5173/auth/callback,https://soty.pp.ua/auth/callback'
        },
        'https://soty.pp.ua'
      )
    ).toEqual([]);

    expect(authProblems({ siteUrl: '', allowList: '' }, 'https://soty.pp.ua')).toEqual([
      'Supabase Site URL is unset, not https://soty.pp.ua',
      'the redirect allow-list does not contain https://soty.pp.ua/auth/callback'
    ]);

    expect(
      authProblems(
        {
          siteUrl: 'https://soty.pp.ua/',
          allowList: 'https://soty.pp.ua/auth/callback,https://*.pages.dev/*'
        },
        'https://soty.pp.ua'
      )
    ).toEqual(['the redirect allow-list contains wildcards: https://*.pages.dev/*']);
  });

  it('requires one origin across the bundle, the functions and the binding', () => {
    expect(
      originAgreement({
        binding: 'https://soty.pp.ua',
        webSiteUrl: 'https://soty.pp.ua/',
        functionSiteUrl: 'https://soty.pp.ua'
      })
    ).toEqual([]);
    expect(
      originAgreement({
        binding: 'https://soty.pp.ua',
        webSiteUrl: 'https://staging.soty.pp.ua',
        functionSiteUrl: undefined
      })
    ).toEqual([
      'the web bundle targets https://staging.soty.pp.ua, the binding is https://soty.pp.ua'
    ]);
  });
});
