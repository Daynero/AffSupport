import { describe, expect, it } from 'vitest';
import {
  assetPaths,
  deployedConfigProblems,
  extractSupabaseConfig,
  manifestAgreement,
  oauthStartProblems,
  shellProblems,
  spaRouteProblems,
  summarize
} from '../scripts/lib/live-smoke.mjs';

const signed = {
  version: '1.1.0',
  buildId: '1.1.0+63',
  apiVersion: 3,
  minimumSupportedVersion: '1.0.0',
  artifacts: {
    'macos-arm64': { sha256: 'a'.repeat(64) },
    'windows-x64': { sha256: 'b'.repeat(64) }
  },
  signature: 'signature'
};

describe('live deployment judgements', () => {
  it('accepts the manifest this release signed', () => {
    expect(manifestAgreement({ ...signed }, signed)).toEqual([]);
  });

  it('catches a site still serving the previous release', () => {
    // The deploy reports success and the site keeps serving what it had: the
    // upload went somewhere else, or the manifest commit never made the build.
    const problems = manifestAgreement(
      { ...signed, version: '1.0.4', buildId: '1.0.4+58' },
      signed
    );
    expect(problems).toEqual([
      'the served manifest version is 1.0.4, this release signed 1.1.0',
      'the served manifest buildId is 1.0.4+58, this release signed 1.1.0+63'
    ]);
  });

  it('catches a manifest that offers different bytes under the same version', () => {
    const tampered = {
      ...signed,
      artifacts: { ...signed.artifacts, 'macos-arm64': { sha256: 'c'.repeat(64) } }
    };
    expect(manifestAgreement(tampered, signed)).toEqual([
      'the served macos-arm64 digest is not the one this release signed'
    ]);
  });

  it('catches a platform quietly dropped from the served manifest', () => {
    const partial = { ...signed, artifacts: { 'macos-arm64': signed.artifacts['macos-arm64'] } };
    expect(manifestAgreement(partial, signed)).toEqual([
      'the served manifest offers macos-arm64, this release signed macos-arm64, windows-x64'
    ]);
  });

  it('refuses a served manifest with no signature, which every client rejects', () => {
    const unsigned = { ...signed, signature: undefined };
    expect(manifestAgreement(unsigned, signed)).toEqual([
      'the served manifest carries no signature'
    ]);
  });

  it('reports a deep link that the hosting turned into a 404', () => {
    expect(spaRouteProblems({ status: 200, contentType: 'text/html' }, '/compressor')).toEqual([]);
    expect(spaRouteProblems({ status: 404, contentType: 'text/html' }, '/compressor')).toEqual([
      '/compressor answered HTTP 404, not the app shell'
    ]);
    expect(
      spaRouteProblems({ status: 200, contentType: 'application/json' }, '/compressor')
    ).toEqual(['/compressor answered application/json, not HTML']);
  });

  it('sees through a page that returns 200 and renders nothing', () => {
    const real =
      '<!doctype html><div id="root"></div><script type="module" src="/assets/index-abc.js"></script>';
    expect(shellProblems(real)).toEqual([]);
    expect(assetPaths(real)).toEqual(['/assets/index-abc.js']);

    const edgeError = '<html><body>Cloudflare Error 1101</body></html>';
    expect(shellProblems(edgeError)).toEqual([
      'the served page has no application root element',
      'the served page references no built asset bundle',
      'the origin served an edge error page rather than the application'
    ]);
    expect(assetPaths(edgeError)).toEqual([]);
  });

  it('reads the first hop of sign-in, which is all that works without an account', () => {
    expect(
      oauthStartProblems({
        status: 302,
        location:
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com'
      })
    ).toEqual([]);

    // A provider switched off is "login does nothing", reported as a number.
    expect(oauthStartProblems({ status: 400 })).toEqual([
      'the identity provider handshake answered HTTP 400, not a redirect'
    ]);
    expect(
      oauthStartProblems({ status: 302, location: 'https://soty.pp.ua/?error=provider_disabled' })
    ).toEqual([
      'the identity handshake redirected to soty.pp.ua, not Google',
      'the identity handshake carries no client id'
    ]);
  });

  it('collects the entry chunk first and then the preloaded ones, without repeats', () => {
    const html =
      '<link rel="modulepreload" href="/assets/config-x.js">' +
      '<script type="module" src="/assets/index-abc.js"></script>' +
      '<link rel="modulepreload" href="/assets/config-x.js">';
    expect(assetPaths(html)).toEqual(['/assets/index-abc.js', '/assets/config-x.js']);
  });

  it('reads the configuration the browser is actually running with', () => {
    // Taken from the deployment rather than configured alongside it: a key
    // supplied out of band proves that *a* key works, this proves the one real
    // users were handed works.
    const chunk =
      'const u="https://yvvvignywfmbdgkcxtfk.supabase.co",k="sb_publishable_AbCdEf123456";';
    expect(extractSupabaseConfig(chunk)).toEqual({
      url: 'https://yvvvignywfmbdgkcxtfk.supabase.co',
      publishableKey: 'sb_publishable_AbCdEf123456'
    });
    expect(extractSupabaseConfig('const nothing=1;')).toEqual({ url: null, publishableKey: null });
  });

  it('catches a bundle built for one project and deployed to another', () => {
    // It reads and writes the wrong database while looking entirely healthy.
    expect(
      deployedConfigProblems(
        {
          url: 'https://otherprojectref0000.supabase.co',
          publishableKey: 'sb_publishable_x1234567890'
        },
        { supabaseUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co' }
      )
    ).toEqual([
      'the served bundle talks to https://otherprojectref0000.supabase.co, not https://yvvvignywfmbdgkcxtfk.supabase.co'
    ]);
  });

  it('refuses a bundle that hands every visitor a privileged key', () => {
    expect(
      deployedConfigProblems(
        {
          url: 'https://yvvvignywfmbdgkcxtfk.supabase.co',
          publishableKey: 'sb_secret_oh_no_1234567'
        },
        { supabaseUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co' }
      )
    ).toEqual(['the served bundle ships a privileged Supabase key']);
    expect(
      deployedConfigProblems(
        { url: null, publishableKey: null },
        { supabaseUrl: 'https://yvvvignywfmbdgkcxtfk.supabase.co' }
      )
    ).toEqual([
      'the served bundle names no Supabase project',
      'the served bundle carries no Supabase key'
    ]);
  });

  it('counts a probe that could not run as a failure, never as a skip', () => {
    const verdict = summarize([
      { name: 'shell', problems: [] },
      { name: 'functions', problems: ['could not be checked: fetch failed'] }
    ]);
    expect(verdict).toEqual({
      ok: false,
      checked: 2,
      failures: ['functions: could not be checked: fetch failed']
    });
  });
});
