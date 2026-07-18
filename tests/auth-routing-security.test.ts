// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { validatePublicConfig } from '../apps/web/src/lib/config';
import { loginUrl, safeReturnPath } from '../apps/web/src/lib/redirects';
import { protectedRouteDecision, routeKind } from '../apps/web/src/Root';
import { translate } from '../apps/web/src/i18n';

describe('protected routing and safe OAuth returns', () => {
  it('preserves only known internal Wishly routes', () => {
    expect(safeReturnPath('/compressor')).toBe('/compressor');
    expect(safeReturnPath('/account?tab=privacy')).toBe('/account?tab=privacy');
    expect(safeReturnPath('/admin#users')).toBe('/admin#users');
    expect(safeReturnPath('https://evil.example/steal')).toBe('/');
    expect(safeReturnPath('//evil.example/steal')).toBe('/');
    expect(safeReturnPath('/unknown')).toBe('/');
    expect(loginUrl('/compressor')).toBe('/login?returnTo=%2Fcompressor');
  });

  it('gates protected content until session and profile checks finish', () => {
    expect(
      protectedRouteDecision({
        status: 'initializing',
        hasSession: false,
        hasProfile: false,
        accountStatus: null,
        configurationError: false
      })
    ).toBe('loading');
    expect(
      protectedRouteDecision({
        status: 'unauthenticated',
        hasSession: false,
        hasProfile: false,
        accountStatus: null,
        configurationError: false
      })
    ).toBe('login');
    expect(
      protectedRouteDecision({
        status: 'authenticated',
        hasSession: true,
        hasProfile: true,
        accountStatus: 'active',
        configurationError: false
      })
    ).toBe('allow');
    expect(
      protectedRouteDecision({
        status: 'authenticated',
        hasSession: true,
        hasProfile: true,
        accountStatus: 'blocked',
        configurationError: false
      })
    ).toBe('blocked');
  });

  it('keeps direct /compressor routing and production SPA fallback', async () => {
    expect(routeKind('/compressor')).toBe('compressor');
    expect(routeKind('/')).toBe('home');
    const redirects = await readFile('apps/web/public/_redirects', 'utf8');
    expect(redirects).toContain('/* /index.html 200');
  });

  it('starts the local Agent provider only inside the authenticated application', async () => {
    const [root, protectedApplication] = await Promise.all([
      readFile('apps/web/src/Root.tsx', 'utf8'),
      readFile('apps/web/src/ProtectedWishly.tsx', 'utf8')
    ]);
    expect(root).toContain("lazy(() => import('./ProtectedWishly'))");
    expect(root).not.toContain('<AgentProvider>');
    expect(protectedApplication).toContain('<AgentProvider>');
    expect(protectedApplication).toContain("path === '/compressor'");
  });
});

describe('environment and localization foundation', () => {
  it('reports every missing public setting instead of starting with undefined config', () => {
    const missing = validatePublicConfig({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors).toEqual(
        expect.arrayContaining([
          'VITE_SUPABASE_URL is missing.',
          'VITE_SUPABASE_PUBLISHABLE_KEY is missing.',
          'VITE_SITE_URL is missing.'
        ])
      );
    }
  });

  it('accepts publishable browser config without requiring a secret key', () => {
    expect(
      validatePublicConfig({
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_value_only',
        VITE_SITE_URL: 'https://wishly-app.pages.dev'
      }).ok
    ).toBe(true);
  });

  it('rejects privileged Supabase keys and localhost as a production callback origin', () => {
    const serviceRolePayload = btoa(JSON.stringify({ role: 'service_role' }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    expect(
      validatePublicConfig({
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: `header.${serviceRolePayload}.signature`,
        VITE_SITE_URL: 'https://wishly-app.pages.dev'
      }).ok
    ).toBe(false);
    expect(
      validatePublicConfig({
        PROD: true,
        VITE_SUPABASE_URL: 'https://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_value_only',
        VITE_SITE_URL: 'http://127.0.0.1:5173'
      }).ok
    ).toBe(false);
  });

  it('contains the required EN and UA login and consent copy', () => {
    expect(translate('en', 'loginHeading')).toBe('Sign in to Wishly');
    expect(translate('uk', 'loginHeading')).toBe('Увійдіть у Wishly');
    expect(translate('en', 'continueGoogle')).toBe('Continue with Google');
    expect(translate('uk', 'continueGoogle')).toBe('Продовжити з Google');
    expect(translate('en', 'marketingConsent')).toBe(
      'Receive news about new Wishly tools and updates.'
    );
    expect(translate('uk', 'marketingConsent')).toBe(
      'Отримувати новини про нові інструменти та оновлення Wishly.'
    );
  });

  it('disables new decorative auth motion for reduced-motion users', async () => {
    const css = await readFile('apps/web/src/styles.css', 'utf8');
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('.login-accent');
    expect(block).toContain('.onboarding-modal');
    expect(block).toContain('animation: none !important');
  });
});

describe('static database and credential security checks', () => {
  it('enables RLS without public using(true) policies', async () => {
    const migrations = (
      await Promise.all([
        readFile('supabase/migrations/20260718210000_profiles_and_admin.sql', 'utf8'),
        readFile('supabase/migrations/20260718211000_analytics.sql', 'utf8'),
        readFile('supabase/migrations/20260718212000_admin_functions.sql', 'utf8')
      ])
    ).join('\n');
    expect(migrations.match(/enable row level security/g)?.length).toBe(3);
    expect(migrations).not.toMatch(/using\s*\(\s*true\s*\)/i);
    expect(migrations).toContain('user_id = (select auth.uid())');
    expect(migrations).toContain('security definer');
    expect(migrations).toContain("set search_path = ''");
  });

  it('keeps privileged deletion on the server and targets only the JWT user', async () => {
    const [edge, frontend] = await Promise.all([
      readFile('supabase/functions/delete-account/index.ts', 'utf8'),
      readFile('apps/web/src/pages/AccountPage.tsx', 'utf8')
    ]);
    expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
    expect(edge).toContain('admin.auth.getUser(jwt)');
    expect(edge).toContain('deleteUser(user.id, false)');
    expect(edge).not.toMatch(/request\.json\(|body\.user|user_id\s*=/);
    expect(frontend).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('requests only standard identity scopes and never provider offline access', async () => {
    const auth = await readFile('apps/web/src/auth/AuthContext.tsx', 'utf8');
    expect(auth).toContain("scopes: 'openid email profile'");
    expect(auth).not.toMatch(/drive|gmail|contacts|calendar|access_type|provider_token/i);
  });

  it('keeps Supabase credentials and JWTs out of the local Agent', async () => {
    const files = ['apps/agent/src/index.ts', 'apps/agent/src/http.ts', 'apps/agent/src/config.ts'];
    const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
    expect(source).not.toMatch(/supabase|google.*token|service.role|bearer.*jwt/i);
  });
});
