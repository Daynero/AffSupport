import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';

const environment = loadEnv('production', process.cwd(), '');
const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SITE_URL'];
const failures = required
  .filter(name => !environment[name]?.trim())
  .map(name => `${name} is missing`);
const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

function legacyRole(key) {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(
      Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64url').toString('utf8')
    ).role;
  } catch {
    return null;
  }
}

if (
  /^sb_(?:secret|service_role)_/i.test(publishableKey) ||
  legacyRole(publishableKey) === 'service_role'
)
  failures.push('the Supabase browser key is privileged');

let siteOrigin = null;
try {
  const site = new URL(environment.VITE_SITE_URL);
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash)
    failures.push('VITE_SITE_URL is not a production HTTPS origin');
  else siteOrigin = site.origin;
} catch {
  if (environment.VITE_SITE_URL) failures.push('VITE_SITE_URL is invalid');
}

const releaseEnvironment = Object.fromEntries(
  (await readFile('config/production.env', 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
);

if (siteOrigin && siteOrigin !== releaseEnvironment.PUBLIC_SITE_ORIGIN)
  failures.push('VITE_SITE_URL does not match the release production origin');

if (failures.length) {
  console.error(`Production web environment check failed: ${failures.join('; ')}.`);
  process.exitCode = 1;
} else {
  console.log('Production web environment is complete and uses only a public Supabase key.');
}
