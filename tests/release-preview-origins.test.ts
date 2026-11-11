import { describe, expect, it } from 'vitest';
import {
  PREVIEW_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN,
  isSotySiteOrigin
} from '../packages/shared/src/release.js';
import { originsFor } from '../apps/agent/src/config';
import { allowedBrowserOrigins, returnSiteOrigin } from '../supabase/functions/_shared/cors';
import { signInRedirectUri } from '../supabase/functions/_shared/google-redirect';
import { runtimeSiteUrl, siteChannel } from '../apps/web/src/lib/config';
import { releaseManifestUrl, RELEASE_MANIFEST_URL } from '../apps/web/src/release-manifest';
import { pairingPath } from '../apps/web/src/connection';
import { fetchReleaseTesterStatus } from '../apps/web/src/lib/release-tester';
import { productionBinding } from '../scripts/lib/release/bindings.mjs';
import { resolveTargetBinding } from '../scripts/lib/release/targets.mjs';

/**
 * Feature 051: `next` is the same production at a second address. It is
 * trusted exactly where the production origin is trusted, and nowhere else.
 */

const OTHER = 'https://next.soty.pp.ua.evil.test';

describe('one production, two exact origins', () => {
  it('names only the two origins', () => {
    expect(isSotySiteOrigin(PRODUCTION_SITE_ORIGIN)).toBe(true);
    expect(isSotySiteOrigin(PREVIEW_SITE_ORIGIN)).toBe(true);
    for (const origin of [OTHER, 'http://next.soty.pp.ua', 'https://soty.pp.ua/', null])
      expect(isSotySiteOrigin(origin)).toBe(false);
  });

  it('lets a production agent trust next, and never a beta or development agent', () => {
    const base = { devOrigin: 'http://127.0.0.1:5173', host: '127.0.0.1', port: 43120 };
    expect(
      originsFor({ ...base, publicOrigin: PRODUCTION_SITE_ORIGIN }).has(PREVIEW_SITE_ORIGIN)
    ).toBe(true);
    expect(
      originsFor({ ...base, publicOrigin: 'http://127.0.0.1:5175' }).has(PREVIEW_SITE_ORIGIN)
    ).toBe(false);
    expect(originsFor({ ...base, publicOrigin: null }).has(PREVIEW_SITE_ORIGIN)).toBe(false);
  });

  it('lets the functions answer next only when the configured site is production', () => {
    expect(allowedBrowserOrigins(PRODUCTION_SITE_ORIGIN).has(PREVIEW_SITE_ORIGIN)).toBe(true);
    expect(allowedBrowserOrigins('http://127.0.0.1:5175').has(PREVIEW_SITE_ORIGIN)).toBe(false);
    expect(allowedBrowserOrigins(PRODUCTION_SITE_ORIGIN).has(OTHER)).toBe(false);
  });

  it('returns a browser flow to next only when it started there', () => {
    expect(returnSiteOrigin(PRODUCTION_SITE_ORIGIN, PREVIEW_SITE_ORIGIN)).toBe(PREVIEW_SITE_ORIGIN);
    expect(returnSiteOrigin(PRODUCTION_SITE_ORIGIN, OTHER)).toBe(PRODUCTION_SITE_ORIGIN);
    expect(returnSiteOrigin(PRODUCTION_SITE_ORIGIN, 'http://127.0.0.1:43120')).toBe(
      PRODUCTION_SITE_ORIGIN
    );
    expect(returnSiteOrigin('http://127.0.0.1:5175', PREVIEW_SITE_ORIGIN)).toBe(
      'http://127.0.0.1:5175'
    );
    expect(
      signInRedirectUri({ WISHLY_SITE_URL: PRODUCTION_SITE_ORIGIN }, PREVIEW_SITE_ORIGIN)
    ).toBe(`${PREVIEW_SITE_ORIGIN}/auth/callback`);
    expect(signInRedirectUri({ WISHLY_SITE_URL: PRODUCTION_SITE_ORIGIN })).toBe(
      `${PRODUCTION_SITE_ORIGIN}/auth/callback`
    );
  });
});

describe('the same web bundle on either address', () => {
  it('takes the site URL from the page on either production origin', () => {
    expect(runtimeSiteUrl(PRODUCTION_SITE_ORIGIN, PREVIEW_SITE_ORIGIN)).toBe(PREVIEW_SITE_ORIGIN);
    expect(runtimeSiteUrl(PRODUCTION_SITE_ORIGIN, PRODUCTION_SITE_ORIGIN)).toBe(
      PRODUCTION_SITE_ORIGIN
    );
    // The agent's local copy hands sign-in to the main site, as before.
    expect(runtimeSiteUrl(PRODUCTION_SITE_ORIGIN, 'http://127.0.0.1:43120')).toBe(
      PRODUCTION_SITE_ORIGIN
    );
    // A beta bundle never adopts a production origin.
    expect(runtimeSiteUrl('http://127.0.0.1:5175', PREVIEW_SITE_ORIGIN)).toBe(
      'http://127.0.0.1:5175'
    );
  });

  it('knows which address it is on', () => {
    expect(siteChannel(PREVIEW_SITE_ORIGIN)).toBe('next');
    expect(siteChannel(PRODUCTION_SITE_ORIGIN)).toBe('production');
    expect(siteChannel('http://127.0.0.1:43120')).toBe('other');
  });

  it('reads the agent channel from its own address', () => {
    expect(releaseManifestUrl(PREVIEW_SITE_ORIGIN)).toBe(
      `${PREVIEW_SITE_ORIGIN}/.well-known/wishly/stable.json`
    );
    expect(releaseManifestUrl(PRODUCTION_SITE_ORIGIN)).toBe(RELEASE_MANIFEST_URL);
    expect(releaseManifestUrl('http://127.0.0.1:43120')).toBe(RELEASE_MANIFEST_URL);
  });

  it('asks the agent to pair back to next, and leaves the main site unchanged', () => {
    const agent = 'http://127.0.0.1:43120';
    expect(pairingPath(agent, PREVIEW_SITE_ORIGIN)).toBe(
      `/pair?origin=${encodeURIComponent(PREVIEW_SITE_ORIGIN)}`
    );
    expect(pairingPath(agent, PRODUCTION_SITE_ORIGIN)).toBe('/pair');
    expect(pairingPath(agent, agent)).toBe('/local');
  });
});

describe('who may use next', () => {
  const answer = (data: unknown, error: { code?: string } | null) => async () => ({ data, error });

  it('trusts the database answer', async () => {
    expect(await fetchReleaseTesterStatus(answer(true, null), false)).toBe('tester');
    expect(await fetchReleaseTesterStatus(answer(false, null), true)).toBe('not_tester');
  });

  it('lets administrators in before the tester list exists, and nobody else', async () => {
    const missing = answer(null, { code: 'PGRST202' });
    expect(await fetchReleaseTesterStatus(missing, true)).toBe('tester');
    expect(await fetchReleaseTesterStatus(missing, false)).toBe('not_tester');
    expect(await fetchReleaseTesterStatus(answer(null, { code: '42501' }), true)).toBe(
      'not_tester'
    );
  });
});

describe('release binding', () => {
  it('pins the preview of production to release identity', () => {
    const production = productionBinding();
    expect(production).toMatchObject({
      previewSiteOrigin: PREVIEW_SITE_ORIGIN,
      previewBranch: 'next'
    });
    // A binding file written before 051 still resolves, with the preview derived.
    const legacy = { ...production } as Record<string, unknown>;
    delete legacy.previewSiteOrigin;
    delete legacy.previewBranch;
    const resolved = resolveTargetBinding(
      { targetId: 'production', targetKind: 'production' },
      { production: legacy }
    );
    expect(resolved.previewSiteOrigin).toBe(PREVIEW_SITE_ORIGIN);
    expect(() =>
      resolveTargetBinding(
        { targetId: 'production', targetKind: 'production' },
        { production: { ...production, previewSiteOrigin: 'https://evil.test' } }
      )
    ).toThrow('pinned');
  });

  it('refuses a sandbox preview that production uses', () => {
    const production = productionBinding();
    const sandbox = {
      kind: 'sandbox',
      bindingId: 'sandbox-local',
      repository: 'example/sandbox',
      releaseRepository: 'example/sandbox-release',
      siteOrigin: 'https://sandbox.example.test',
      previewSiteOrigin: PREVIEW_SITE_ORIGIN,
      previewBranch: 'next',
      cloudflareProject: 'sandbox-pages',
      supabaseProject: 'sandbox-db',
      signingKeyFingerprint: 'sandbox-public',
      artifactUrlBase: 'https://example.test/sandbox'
    };
    expect(() =>
      resolveTargetBinding(
        { targetId: 'sandbox-local', targetKind: 'sandbox' },
        { production, 'sandbox-local': sandbox }
      )
    ).toThrow('previewSiteOrigin');
  });
});
