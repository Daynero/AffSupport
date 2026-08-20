import {
  isProductionEndpoint,
  parseAppEnvironment,
  type AppEnvironment
} from '@video-compressor/shared';

export type PublicConfig = {
  environment: AppEnvironment;
  supabaseUrl: string;
  supabasePublishableKey: string;
  siteUrl: string;
  adminEmailHint: string | null;
  legalContactEmail: string | null;
  productOperator: string | null;
};

export type ConfigResult =
  { ok: true; value: PublicConfig; errors: [] } | { ok: false; value: null; errors: string[] };

type Env = Record<string, string | boolean | undefined>;

export type TeamDirectAddMode = 'disabled' | 'testing';

function value(env: Env, key: string) {
  const raw = env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function validSiteUrl(raw: string, allowPath = false) {
  try {
    const url = new URL(raw);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return false;
    return allowPath || (url.pathname === '/' && !url.search && !url.hash);
  } catch {
    return false;
  }
}

function forbiddenBrowserKey(key: string) {
  if (/^sb_(?:secret|service_role)_/i.test(key)) return true;
  const payload = key.split('.')[1];
  if (!payload || typeof atob !== 'function') return false;
  try {
    const decoded = JSON.parse(
      atob(
        payload
          .replaceAll('-', '+')
          .replaceAll('_', '/')
          .padEnd(Math.ceil(payload.length / 4) * 4, '=')
      )
    ) as { role?: unknown };
    return decoded.role === 'service_role';
  } catch {
    return false;
  }
}

export function validatePublicConfig(env: Env): ConfigResult {
  const supabaseUrl = value(env, 'VITE_SUPABASE_URL');
  const supabasePublishableKey = value(env, 'VITE_SUPABASE_PUBLISHABLE_KEY');
  const siteUrl = value(env, 'VITE_SITE_URL');
  const directAddMode = value(env, 'VITE_TEAM_DIRECT_ADD_MODE');
  const errors: string[] = [];

  // Which environment this bundle belongs to decides which origins are legal.
  // Absent means production, so a build that forgets the value gets the
  // stricter rules rather than silently behaving like beta.
  const parsedEnvironment = parseAppEnvironment(env.VITE_APP_ENVIRONMENT);
  if (!parsedEnvironment.ok)
    errors.push(`VITE_APP_ENVIRONMENT is invalid: ${parsedEnvironment.error}`);
  const environment: AppEnvironment = parsedEnvironment.ok ? parsedEnvironment.value : 'production';
  const beta = environment === 'beta';

  if (!supabaseUrl) errors.push('VITE_SUPABASE_URL is missing.');
  else if (!validSiteUrl(supabaseUrl, true)) errors.push('VITE_SUPABASE_URL must be a valid URL.');

  if (!supabasePublishableKey) errors.push('VITE_SUPABASE_PUBLISHABLE_KEY is missing.');
  else if (supabasePublishableKey.length < 20)
    errors.push('VITE_SUPABASE_PUBLISHABLE_KEY is not a valid publishable or anon key.');
  else if (forbiddenBrowserKey(supabasePublishableKey))
    errors.push('VITE_SUPABASE_PUBLISHABLE_KEY must not be a secret or service_role key.');

  if (!siteUrl) errors.push('VITE_SITE_URL is missing.');
  else if (!validSiteUrl(siteUrl))
    errors.push('VITE_SITE_URL must be an HTTPS origin (localhost may use HTTP).');
  else if (
    env.PROD === true &&
    !beta &&
    ['localhost', '127.0.0.1'].includes(new URL(siteUrl).hostname)
  )
    errors.push('VITE_SITE_URL must use the production HTTPS origin in a production build.');

  if (directAddMode && !['disabled', 'testing'].includes(directAddMode)) {
    errors.push('VITE_TEAM_DIRECT_ADD_MODE must be disabled or testing.');
  }

  // A beta bundle that could reach production is worse than one that will not
  // load: it would quietly read and write real data while looking like a test
  // environment. Fail the configuration instead.
  if (beta) {
    for (const [key, candidate] of [
      ['VITE_SUPABASE_URL', supabaseUrl],
      ['VITE_SITE_URL', siteUrl],
      ['VITE_AGENT_URL', value(env, 'VITE_AGENT_URL')]
    ] as const) {
      if (candidate && isProductionEndpoint(candidate)) {
        errors.push(`BETA_PRODUCTION_ENDPOINT: ${key} points at ${candidate}, which is not local.`);
      }
    }
    if (value(env, 'VITE_LOCAL_DEV_AUTH') === 'true') {
      errors.push(
        'BETA_LOCAL_AUTH_FORBIDDEN: VITE_LOCAL_DEV_AUTH=true would bypass real authentication.'
      );
    }
  }

  if (errors.length) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      environment,
      supabaseUrl: supabaseUrl.replace(/\/$/, ''),
      supabasePublishableKey,
      siteUrl: siteUrl.replace(/\/$/, ''),
      adminEmailHint: value(env, 'VITE_ADMIN_EMAIL') || null,
      legalContactEmail: value(env, 'VITE_LEGAL_CONTACT_EMAIL') || null,
      productOperator: value(env, 'VITE_PRODUCT_OPERATOR') || null
    }
  };
}

export const publicConfig = validatePublicConfig(import.meta.env);

export function configuredTeamDirectAddMode(env: Env = import.meta.env): TeamDirectAddMode {
  return value(env, 'VITE_TEAM_DIRECT_ADD_MODE') === 'testing' ? 'testing' : 'disabled';
}

export function configuredSiteUrl() {
  return publicConfig.ok ? publicConfig.value.siteUrl : window.location.origin;
}

export function configuredEnvironment(): AppEnvironment {
  return publicConfig.ok ? publicConfig.value.environment : 'production';
}
