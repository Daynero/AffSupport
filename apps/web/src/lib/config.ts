export type PublicConfig = {
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
  const errors: string[] = [];

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
  else if (env.PROD === true && ['localhost', '127.0.0.1'].includes(new URL(siteUrl).hostname))
    errors.push('VITE_SITE_URL must use the production HTTPS origin in a production build.');

  if (errors.length) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
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

export function configuredSiteUrl() {
  return publicConfig.ok ? publicConfig.value.siteUrl : window.location.origin;
}
